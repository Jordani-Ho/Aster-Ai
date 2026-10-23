import { test, expect } from './fixtures'
test('V2-04 一句话草稿不入账，真人确认后钱账同步；退款、扣费与康币停用互不影响',async({people})=>{
 const teacher=people.teacher.page,student=people.student.page
 // 邀请在学生端建立账本；此用例独立登记老师的空账，不预充值。
 await teacher.evaluate(async({teacher,student})=>{
  const p='/src/core/store/index.ts',r='/src/core/ledger/runtime.ts',q='/src/core/ledger/sync.ts'
  await(await import(r)).restoreWithLedgerPaused(async()=>{const s=await(await import(p)).resumeStore(),sync=(await import(q)).createLedgerSync({identity:s.identity,store:s.store,send:async()=>{}});try{await sync.open(teacher,student)}finally{await sync.close();s.store.close();s.identity.privateKey.fill(0)}})
 },{teacher:people.teacher.actor.pubkey,student:people.student.actor.pubkey})
 let events=[{type:'topup',amount:'100'},{type:'gift',amount:'20'}],calls=0
 await teacher.route('https://model.synthetic.example/v1/chat/completions',async route=>{
  if(!route.request().postData()?.includes('钱账草稿'))return route.fallback()
  calls++;await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({events})}}]})})
 })
 await teacher.getByRole('button',{name:'我的馆',exact:true}).click()
 await teacher.locator('summary').filter({hasText:/^钱账$/}).click()
 await teacher.getByLabel('这位学生的称呼').fill('合成小王')
 await teacher.getByLabel('钱账币种',{exact:true}).selectOption('CNY')
 const say=async(text:string)=>{await teacher.getByLabel('说一句话记账').fill(text);await teacher.getByRole('button',{name:'生成记账草稿',exact:true}).click();await expect(teacher.getByRole('article',{name:'钱账确认草稿'})).toBeVisible()}
 const count=()=>teacher.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{const refs=await s.store.list('ledger-index');const ref=refs[0].value as any;const state=await s.store.get(ref.collection,ref.key) as any;return state.ledger.events.length}finally{s.store.close();s.identity.privateKey.fill(0)}})
 await say('收到合成小王 100，送 20');expect(await count()).toBe(0)
 await teacher.getByRole('button',{name:'取消草稿',exact:true}).click();expect(await count()).toBe(0)
 await say('收到合成小王 100，送 20')
 const before=calls
 await teacher.getByRole('button',{name:'确认入账',exact:true}).click({clickCount:2})
 await expect(teacher.getByText(/钱账余额：.*120\.00/)).toBeVisible();expect(calls).toBe(before);expect(await count()).toBe(2)
 await student.getByRole('button',{name:'我',exact:true}).click();await student.locator('summary').filter({hasText:/^设置$/}).click();await student.locator('summary').filter({hasText:/^钱账与对账$/}).click()
 await expect(student.getByText(/钱账余额：.*120\.00/)).toBeVisible()
 events=[{type:'refund',amount:'101'}];await say('退给合成小王 101')
 await teacher.getByRole('button',{name:'确认入账',exact:true}).click();await expect(teacher.getByRole('alert')).toContainText('退款');expect(await count()).toBe(2)
 await teacher.getByRole('button',{name:'取消草稿',exact:true}).click()
 events=[{type:'refund',amount:'50'}];await say('退给合成小王 50');await teacher.getByRole('button',{name:'确认入账',exact:true}).click()
 await expect(student.getByText(/钱账余额：.*70\.00/)).toBeVisible()
 events=[{type:'charge',amount:'80'}];await say('扣合成小王 80');await teacher.getByRole('button',{name:'确认入账',exact:true}).click()
 await expect(student.getByText(/钱账余额：.*-.*10\.00/)).toBeVisible();expect(await count()).toBe(4)
 expect(await student.locator('body').innerText()).not.toMatch(/康币余额|康币账本/)
 const records=await teacher.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return await s.store.list('kangbi-events')}finally{s.store.close();s.identity.privateKey.fill(0)}})
 expect(records).toEqual([])
})
