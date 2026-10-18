import {readFileSync} from 'node:fs'
import { it,expect,vi } from 'vitest'
import {IDBFactory} from 'fake-indexeddb'
import {createIdentity} from '../identity'
import {openStore} from '../store'
import {currentCarePlan,verifySignedCarePlan} from './index'
import {issueCarePlan,retryCarePlan,PlanUndeliveredError} from './issue'
import {draftCarePlan} from '../drafting/careplan'
import {getDailyMirror} from '../mirror'
import {addTeacher,createInbox} from '../inbox'
 it('M1-20 方案起草不签字；真人签发经 M1-18 收件，固定次日建议引用方案；只保留签发索引',async()=>{
 const identity=createIdentity(),student=createIdentity()
 const store=await openStore(identity,{factory:new IDBFactory()}), target=await openStore(student,{factory:new IDBFactory()})
 try{
  await addTeacher(target,identity.publicKey)
  const body={constitution:'合成体质',points:['合成调养要点'],avoid:['合成禁忌']}
  const draft=await draftCarePlan('合成老师要点',{complete:vi.fn().mockResolvedValue(JSON.stringify({...body,source:'teacher',version:999})),stream:vi.fn()})
  expect(draft).toEqual({...body,source:'ai_draft'});expect(await store.list('care-plan-issued')).toEqual([])
  const day=()=>new Date('2026-10-17T09:00:00Z'),tomorrow=()=>new Date('2026-10-18T09:00:00Z')
  const input={carePlan:null,jieqi:'寒露',weather:null,recentCheckins:[],recentSymptoms:[],now:day}
  const today=await getDailyMirror(target,input)
  const inbox=createInbox({identity:student,store:target})
  const send=vi.fn(async(_recipient,envelope)=>{await inbox.receive({sender:identity.publicKey,envelope} as any)})
  const first=await issueCarePlan({identity,store,student:student.publicKey,draft,send,now:day})
  expect(first.version).toBe(1);expect(send).toHaveBeenCalledOnce()
  const received=await currentCarePlan(target,identity.publicKey)
  expect(received?.points).toEqual(body.points)
  expect(await getDailyMirror(target,{...input,carePlan:received})).toEqual(today)
  const model={complete:vi.fn().mockResolvedValue(JSON.stringify({today:['合成调养要点']})),stream:vi.fn()}
  expect((await getDailyMirror(target,{...input,carePlan:received,now:tomorrow,llm:model})).today).toContain('合成调养要点')
  expect(JSON.parse(model.complete.mock.calls[0][0][1].content).carePlan.points).toEqual(body.points)
  expect(JSON.stringify(await store.list('care-plan-issued'))).not.toContain('合成调养要点')
  expect(await store.list('care-plan-pending')).toEqual([])
  const own=await issueCarePlan({identity,store,student:identity.publicKey,draft,now:day})
  expect((await currentCarePlan(store,identity.publicKey))?.points).toEqual(body.points);expect(own.version).toBe(1)
 }finally{store.close();target.close();identity.privateKey.fill(0);student.privateKey.fill(0)}
})
it('方案发不出保留同一签名供重发，重发不调用模型、不增加版本',async()=>{
 const identity=createIdentity(),store=await openStore(identity,{factory:new IDBFactory()}),student='b'.repeat(64)
 try{
  const draft={constitution:'合成',points:['合成要点'],avoid:[],source:'ai_draft' as const}
  let pending=''
  try{await issueCarePlan({identity,store,student,draft,send:async()=>{throw Error('offline')}})}catch(cause){expect(cause).toBeInstanceOf(PlanUndeliveredError);pending=(cause as PlanUndeliveredError).pendingKey}
  const stored=(await store.get('care-plan-pending',pending)) as any,ids:string[]=[]
  const plan=await retryCarePlan({identity,store,pendingKey:pending,send:async(_to,envelope)=>{ids.push((envelope.payload as any).id)}})
  expect(ids).toEqual([stored.event.id]);expect(plan.version).toBe(1)
  expect(verifySignedCarePlan(stored.event,{teacher:identity.publicKey,student}).points).toEqual(draft.points)
 }finally{store.close();identity.privateKey.fill(0)}
})

it('方案签发模块不依赖改稿或模型路径',()=>{const source=readFileSync(new URL('./issue.ts',import.meta.url),'utf8');expect(source).not.toMatch(/from\s+['"][^'"]*(?:llm|drafting)/)})
