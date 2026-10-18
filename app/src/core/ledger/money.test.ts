import { expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { createLedgerSync } from './sync'
import { draftMoney } from './money-draft'
import { confirmMoney, toMinor, formatMoney, moneySummary } from './money'
import { readFileSync } from 'node:fs'

it('老师一句话只生成两条草稿，确认原子入账，重试不重复，确认路径没有模型调用', async()=>{
 const identity=createIdentity(), student=createIdentity().publicKey
 const store=await openStore(identity,{factory:new IDBFactory(),name:crypto.randomUUID()})
 const sync=createLedgerSync({identity,store,send:async()=>{throw Error('合成离线')}})
 const complete=vi.fn(async()=>JSON.stringify({events:[{type:'topup',amount:'100'},{type:'gift',amount:'20'}]}))
 const llm={complete,stream:vi.fn()}
 try {
  await sync.open(identity.publicKey,student)
  const draft=await draftMoney(llm,'收到合成学生 100，送 20',{teacher:identity.publicKey,student,currency:'CNY'})
  expect(draft.events.map(e=>e.amount)).toEqual([10000,2000])
  expect((await sync.view(identity.publicKey,student)).balance).toBe(0)
  await confirmMoney(sync,draft)
  await confirmMoney(sync,draft)
  const view=await sync.view(identity.publicKey,student)
  expect(view.balance).toBe(12000);expect(view.ledger.events).toHaveLength(2)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(formatMoney(view.balance!,'CNY')).toContain('120.00')
  expect(JSON.stringify(moneySummary([view.ledger]))).not.toMatch(new RegExp(identity.publicKey+'|'+student))
 } finally {await sync.close();store.close()}
})

it('金额使用最小单位精确整数，拒绝过多小数、指数、溢出、混合币种与无效草稿',async()=>{
 expect(toMinor('0.29','CNY')).toBe(29)
 expect(toMinor('100','JPY')).toBe(100)
 expect(toMinor('1.234','KWD')).toBe(1234)
 expect(formatMoney(Number.MAX_SAFE_INTEGER,'CNY')).toMatch(/\.91$/)
 expect(formatMoney(-1,'CNY')).toContain('-')
 for(const value of ['0.001','1e3','Infinity','-1','900719925474099.99'])expect(()=>toMinor(value,'CNY')).toThrow()
 const model={complete:vi.fn(async()=>JSON.stringify({events:[{type:'topup',amount:'100',currency:'USD'}]})),stream:vi.fn()}
 await expect(draftMoney(model,'合成输入',{teacher:'a'.repeat(64),student:'b'.repeat(64),currency:'CNY'})).rejects.toThrow()
})

it('旧康币定价换算接口整块删除，钱账与康币账没有互相导入',()=>{
 const chain=readFileSync(new URL('./chain.ts',import.meta.url),'utf8')
 expect(chain).not.toMatch(/declarePricing|perCoin/)
 const money=readFileSync(new URL('./money.ts',import.meta.url),'utf8')
 const kangbi=readFileSync(new URL('../kangbi/index.ts',import.meta.url),'utf8')
 expect(money).not.toMatch(/kangbi/);expect(kangbi).not.toMatch(/ledger|money/)
})

it('批次中一条无效就全部不入账；混币种、学生确认、改内容复用确认号都拒绝',async()=>{
 const teacher=createIdentity(),student=createIdentity(),factory=new IDBFactory()
 const store=await openStore(teacher,{factory,name:crypto.randomUUID()}),other=await openStore(student,{factory,name:crypto.randomUUID()})
 const sync=createLedgerSync({identity:teacher,store,send:async()=>''}),peer=createLedgerSync({identity:student,store:other,send:async()=>''})
 const topup={type:'topup' as const,currency:'CNY',amount:10000}
 try {
  await sync.open(teacher.publicKey,student.publicKey);await peer.open(teacher.publicKey,student.publicKey)
  await expect(sync.recordBatch(teacher.publicKey,student.publicKey,[topup,{type:'gift',currency:'USD',amount:2000}],'synthetic-bad')).rejects.toThrow()
  expect((await sync.view(teacher.publicKey,student.publicKey)).ledger.events).toEqual([])
  await expect(peer.recordBatch(teacher.publicKey,student.publicKey,[topup],'student-attempt')).rejects.toThrow('老师')
  await sync.recordBatch(teacher.publicKey,student.publicKey,[topup],'synthetic-good')
  await expect(sync.recordBatch(teacher.publicKey,student.publicKey,[{...topup,amount:20000}],'synthetic-good')).rejects.toThrow('另一份草稿')
  await expect(sync.recordBatch(teacher.publicKey,student.publicKey,[{type:'gift',currency:'CNY',amount:Number.MAX_SAFE_INTEGER}],'synthetic-overflow')).rejects.toThrow()
  expect((await sync.view(teacher.publicKey,student.publicKey)).balance).toBe(10000)
 } finally {await sync.close();await peer.close();store.close();other.close()}
})
