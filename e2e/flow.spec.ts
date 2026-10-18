import { test, expect, runtime } from './fixtures'
import { actors } from './actors.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
test.use({ seedLedger: true })
async function settings(page: Page) {
  const summary = page.locator('summary').filter({ hasText: /^设置$/ })
  if (await summary.locator('..').getAttribute('open') === null) await summary.click()
}
async function role(page:Page,value:'老师'|'学生') {await expect(page.getByRole('heading',{name:value==='老师'?'老师首页':'问诊首页',exact:true})).toBeVisible();await expect(page.getByText('中继：已连接',{exact:true})).toBeVisible()}
async function stored(page: Page, collection: string) {
  return page.evaluate(async name => {
    const module='/src/core/store/index.ts', { resumeStore }=await import(module), session=await resumeStore().catch(async()=>{const p='/src/core/onboarding/passkey.ts',{authenticatePasskey}=await import(p);return resumeStore({unlockKey:(await authenticatePasskey()).key})})
    try { return (await session.store.list(name)).map((row: any) => ({ key:row.key, value:row.value instanceof Uint8Array ? [...row.value] : row.value })) }
    finally { session.store.close();session.identity.privateKey.fill(0) }
  }, collection)
}
async function book(page: Page) {
  return page.evaluate(async ({teacher,student}) => {
    const storePath='/src/core/store/index.ts', syncPath='/src/core/ledger/sync.ts'
    const { resumeStore }=await import(storePath), session=await resumeStore().catch(async()=>{const p='/src/core/onboarding/passkey.ts',{authenticatePasskey}=await import(p);return resumeStore({unlockKey:(await authenticatePasskey()).key})}), { createLedgerSync }=await import(syncPath)
    // Read-only controller; never start a second transport or mutate the live book.
    const sync=createLedgerSync({ identity:session.identity,store:session.store,send:async()=>{throw Error('read only')} })
    try { const v=await sync.view(teacher,student);return { balance:v.balance,code:v.code } }
    finally { await sync.close();session.store.close();session.identity.privateKey.fill(0) }
  }, {teacher:actors.teacher.pubkey,student:actors.student.pubkey})
}
async function intake(page: Page, quote: string) {
  await page.getByRole('button',{name:'开始采集',exact:true}).click()
  await page.getByRole('button',{name:'开始采集',exact:true}).click()
  await page.getByRole('textbox',{name:'用输入法的语音输入，或直接打字'}).fill(quote)
  await page.getByRole('button',{name:'加入这一句',exact:true}).click()
  await expect(page.getByRole('heading',{name:/还想问一下/})).toBeVisible()
  for(let i=0;i<3;i++) await page.getByRole('button',{name:'跳过',exact:true}).first().click()
  await expect(page.getByRole('heading',{name:'确认后发送'})).toBeVisible()
  await page.getByRole('textbox',{name:'最不舒服的地方（主诉）'}).fill(quote)
  await page.getByRole('textbox',{name:'现在的情况（现病史）'}).fill('SYNTHETIC_PRESENT')
  await page.getByRole('textbox',{name:'以前的病（既往史）'}).fill('SYNTHETIC_HISTORY')
  await page.getByRole('textbox',{name:'在吃的药、过敏'}).fill('SYNTHETIC_NO_MEDS')
}
async function decrypted(page: Page) {
  return page.evaluate(async () => {
    const module='/src/core/store/index.ts', {resumeStore}=await import(module), session=await resumeStore().catch(async()=>{const p='/src/core/onboarding/passkey.ts',{authenticatePasskey}=await import(p);return resumeStore({unlockKey:(await authenticatePasskey()).key})})
    try {
      const archive=await session.store.exportEncrypted({includeBinary:true}), rows=[]
      for(const record of archive.records) {
        const value=await session.store.get(record.c,record.k)
        rows.push({collection:record.c,value:value instanceof Uint8Array?[...value]:value})
      }
      return rows
    } finally {session.store.close();session.identity.privateKey.fill(0)}
  })
}
for(const recovery of ['advanced','passkey'] as const){
test('nine-step consultation: signing, erasure, ledger, homework, '+recovery+' recovery, followup and numeric CSV', async ({ people }) => {
  test.setTimeout(240000)
  const teacher=people.teacher.page,student=people.student.page,quote='SYNTHETIC_PRIVATE_QUOTE_15B'
  await role(teacher,'老师');await role(student,'学生')
  await expect.poll(async()=> (await book(student)).balance).toBe(10)
  await teacher.getByRole('button',{name:'问诊箱',exact:true}).click()
  await intake(student,quote)
  const jpeg=await student.evaluate(()=>{const c=document.createElement('canvas');c.width=32;c.height=24;const ctx=c.getContext('2d')!;ctx.fillStyle='#1a829e';ctx.fillRect(0,0,32,24);return c.toDataURL('image/jpeg').split(',')[1]})
  await student.locator('input[type=file][accept="image/*"]').setInputFiles({name:'synthetic.jpg',mimeType:'image/jpeg',buffer:Buffer.from(jpeg,'base64')})
  await expect(student.getByText(/照片已在本机缩小/)).toBeVisible()
  await student.getByRole('button',{name:'确认发送',exact:true}).click()
  await expect(student.getByRole('heading',{name:'已确认',exact:true})).toBeVisible()
  await expect(teacher.getByRole('heading',{name:quote,exact:true})).toBeVisible()
  await expect(teacher.getByText('照片 1/1',{exact:true})).toBeVisible()
  const photos=await stored(teacher,'attachments');expect(photos).toHaveLength(1)
  const photoBytes=photos[0].value as number[]
  await teacher.getByRole('button',{name:'查看',exact:true}).click()
  await teacher.getByRole('button',{name:'起草并审改',exact:true}).click()
  await expect(teacher.getByText('SYNTHETIC_SUMMARY',{exact:true})).toBeVisible()
  const summary=teacher.locator('article').filter({has:teacher.getByRole('heading',{name:'判断 · 症状摘要',exact:true})})
  await summary.getByRole('button',{name:'修改',exact:true}).click()
  await teacher.locator('.sign-editor textarea').fill('SYNTHETIC_FINAL_SUMMARY')
  await teacher.getByRole('button',{name:'保存修改',exact:true}).click()
  while(await teacher.getByRole('button',{name:'采用',exact:true}).count()) await teacher.getByRole('button',{name:'采用',exact:true}).first().click()
  await teacher.getByRole('spinbutton',{name:'本次扣费（可选，康币）'}).fill('3')
  await teacher.getByRole('button',{name:'确认无误，签字',exact:true}).click()
  await expect(teacher.getByRole('heading',{name:'已签字交还',exact:true})).toBeVisible()
  await expect(teacher.getByRole('dialog',{name:'像不像我评分'})).toBeVisible()
  await teacher.getByRole('button',{name:'5分',exact:true}).click()
  await expect(teacher.getByRole('dialog',{name:'像不像我评分'})).toHaveCount(0)
  await student.getByRole('button',{name:'返回',exact:true}).click()
  await student.getByRole('button',{name:'我的病历',exact:true}).click()
  await expect(student.getByText('证候：SYNTHETIC_PATTERN',{exact:true})).toBeVisible()
  await expect(student.getByText('SYNTHETIC_HOMEWORK',{exact:true})).toBeVisible()
  await student.getByRole('button',{name:'返回',exact:true}).click()
  await student.getByRole('button',{name:'今日作业',exact:true}).click()
  await student.getByRole('button',{name:'已完成',exact:true}).click()
  await expect(student.getByRole('button',{name:'今日已完成 ✓',exact:true})).toBeDisabled()
  await student.getByRole('button',{name:'返回',exact:true}).click()
  const records=await stored(student,'student-records'),assignments=await stored(student,'homework')
  expect(records).toHaveLength(1);expect(assignments).toHaveLength(1)
  await test.step('hard: teacher decrypted IndexedDB has no original quote or processed JPEG, including after relay replay',async()=>{
    await teacher.getByRole('button',{name:'返回首页',exact:true}).click()
    await teacher.reload();await expect(teacher.getByRole('heading',{name:'老师首页',exact:true})).toBeVisible()
    // Reconnect replays history; a completed consult must stay erased.
    await expect(teacher.getByText('中继：已连接',{exact:true})).toBeVisible()
    await teacher.getByRole('button',{name:'问诊箱',exact:true}).click()
    await expect(teacher.getByText(/还没有收到问诊/)).toBeVisible()
    const text=JSON.stringify(await decrypted(teacher))
    expect(text).not.toContain(quote)
    expect(text).not.toContain(JSON.stringify(photoBytes))
    expect(text).not.toContain(Buffer.from(photoBytes).toString('base64'))
    await teacher.getByRole('button',{name:'返回',exact:true}).click()
  })
  await test.step('hard: both displayed balances and comparison codes agree',async()=>{
    await expect.poll(async()=> (await book(student)).balance).toBe(7)
    const t=await book(teacher),s=await book(student);expect(t.balance).toBe(7);expect(t.code).toBe(s.code)
    for(const page of [teacher,student]) {await settings(page);await page.getByText('康币账本与对账',{exact:true}).click();await expect(page.getByText('余额：7 康币 · 对账码：'+s.code,{exact:true})).toBeVisible()}
  })
  const exportRequests:string[]=[]
  const observe=(request:any)=>{if(/^https?:/.test(request.url()))exportRequests.push(request.url())}
  teacher.on('request',observe)
  const downloadPromise=teacher.waitForEvent('download')
  await teacher.getByRole('button',{name:'导出试点指标',exact:true}).click()
  const csv=await readFile((await (await downloadPromise).path())!,'utf8'),lines=csv.trim().split(/\r?\n/),cells=lines[1].split(',')
  if (!process.env.CI) await writeFile(path.resolve('.cache/e2e/pilot-synthetic-local.csv'),csv)
  teacher.off('request',observe);expect(exportRequests).toHaveLength(0)
  expect(lines).toHaveLength(2);expect(cells).toHaveLength(5);expect(cells[0]===records[0].value.id.slice(0,8)).toBe(true)
  expect(Number(cells[1])>0).toBe(true);expect(Math.abs(Number(cells[2])-1/6)<0.00001).toBe(true);expect(Number(cells[3])===3/8).toBe(true);expect(cells[4]==='5').toBe(true)
  for(const secret of [quote,actors.teacher.pubkey,actors.student.pubkey,'SYNTHETIC_FINAL_SUMMARY','SYNTHETIC_HOMEWORK'])expect(!csv.includes(secret)).toBe(true)
  await test.step('hard: clear student storage, restore with mnemonic and real relay backup, recover records/homework/book',async()=>{
    let passkeySession:Awaited<ReturnType<typeof people.student.context.newCDPSession>>|undefined
    if(recovery==='passkey'){
      passkeySession=await people.student.context.newCDPSession(student)
      await passkeySession.send('WebAuthn.enable',{enableUI:false})
      await passkeySession.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}})
      const toggle=student.getByRole('switch',{name:'用刷脸保护并自动备份',exact:true});await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','true')
    }
    await student.getByText('备份状态',{exact:true}).click()
    await student.getByRole('button',{name:'立即备份',exact:true}).click()
    await expect(student.getByText('中继备份成功',{exact:true})).toBeVisible()
    await student.goto('about:blank')
    const cdp=passkeySession??await people.student.context.newCDPSession(student)
    await cdp.send('Storage.clearDataForOrigin',{origin:runtime.baseURL,storageTypes:'all'});if(!passkeySession)await cdp.detach()
    await student.goto('/')
    await expect(student.getByRole('heading',{name:'您是老师还是学生？'})).toBeVisible()
    if(recovery==='passkey'){
      await student.getByText('换手机后找回备份',{exact:true}).click()
      await student.getByLabel('允许用备份替换本机资料',{exact:true}).check()
      await student.getByRole('button',{name:'用刷脸找回备份',exact:true}).click()
      await expect(student.getByRole('heading',{name:'问诊首页',exact:true})).toBeVisible()
      await student.reload();await expect(student.getByRole('button',{name:'刷脸解锁',exact:true})).toBeVisible()
      await expect(student.getByRole('button',{name:'开始采集',exact:true})).toHaveCount(0)
      await student.getByRole('button',{name:'刷脸解锁',exact:true}).click();await expect(student.getByRole('heading',{name:'问诊首页',exact:true})).toBeVisible()
    }else{
      await settings(student);await student.getByText('换手机时用（高级）',{exact:true}).click()
      await student.getByLabel('输入12个词',{exact:true}).fill(actors.student.phrase)
      await student.getByLabel('我已保存需要保留的资料，允许替换',{exact:true}).check()
      await student.getByRole('button',{name:'恢复我的资料',exact:true}).click()
      await expect.poll(async()=>{try{return(await book(student)).balance}catch{return null}}).toBe(7)
      await settings(student);await student.getByText('备份状态',{exact:true}).click()
      await student.getByRole('checkbox',{name:'我已保存需要保留的本机资料，允许替换'}).check()
      await student.getByRole('button',{name:'从中继恢复最新备份'}).click()
      await expect(student.getByText('已从中继恢复',{exact:true})).toBeVisible()
    }
    expect((await stored(student,'student-records')).map((r: { key: string })=>r.key)).toEqual(records.map((r: { key: string })=>r.key))
    expect((await stored(student,'homework'))[0].value.homework.id).toBe(assignments[0].value.homework.id)
    expect((await book(student)).balance).toBe(7)
    await student.getByRole('button',{name:'我的病历',exact:true}).click()
    await expect(student.getByText('证候：SYNTHETIC_PATTERN',{exact:true})).toBeVisible()
    await student.getByRole('button',{name:'返回',exact:true}).click()
    await student.getByRole('button',{name:'今日作业',exact:true}).click()
    await expect(student.getByRole('button',{name:'今日已完成 ✓',exact:true})).toBeDisabled()
    await student.getByRole('button',{name:'返回',exact:true}).click()
  })
  await intake(student,'SYNTHETIC_FOLLOWUP')
  const old=student.locator('.intake-history input[type=checkbox]');await expect(old).toHaveCount(1);await expect(old).toBeChecked()
  await student.getByRole('button',{name:'确认发送',exact:true}).click()
  await expect(student.getByRole('heading',{name:'已确认',exact:true})).toBeVisible()
  await expect.poll(async()=> (await stored(teacher,'consult-package')).length).toBe(1)
  const followup=(await stored(teacher,'consult-package'))[0].value
  expect(followup.history).toHaveLength(1);expect(JSON.parse(followup.history[0]).id).toBe(records[0].key)
})
}

test('hard: student displays only the valid signature after tampered then valid delivery',async({people})=>{
  const teacher=people.teacher.page,student=people.student.page
  await role(student,'学生')
  await teacher.evaluate(async({key,student,teacher,relay})=>{
    const signPath='/src/core/record/sign.ts', transportPath='/src/core/transport/index.ts'
    const {signEncounter}=await import(signPath),{createTransport}=await import(transportPath)
    const unknown=()=>({value:null,source:'unknown'}),field=(value:string)=>({value,source:'student'})
    const encounter={id:'a'.repeat(32),version:1,kind:'remote_async',student,teacher,createdAt:new Date().toISOString(),profile:{alias:unknown(),gender:unknown(),age:unknown(),bazi:unknown(),city:unknown()},intake:{chiefComplaint:field('SYNTHETIC_VALID_RECORD'),presentIllness:unknown(),history:unknown(),medsAllergies:unknown(),attachments:[]},fourExams:{look:unknown(),listenSmell:unknown(),ask:unknown(),pulse:unknown()},judgment:{symptomSummary:{value:'SYNTHETIC_VALID_SUMMARY',source:'teacher'},pattern:unknown(),mechanism:unknown(),rationale:unknown()},plan:{principle:unknown(),prescription:unknown(),advice:unknown(),homework:[]}}
    const valid=JSON.parse(JSON.stringify(signEncounter(encounter,Uint8Array.from(key)))),tampered={...valid,content:valid.content.replace('SYNTHETIC_VALID_RECORD','TAMPERED_RECORD_MUST_NOT_DISPLAY')}
    const channel=createTransport({privateKey:Uint8Array.from(key),relays:[relay],onMessage:()=>{}});channel.start()
    try {await channel.send(student,{type:'record.signed',version:1,payload:tampered});await channel.send(student,{type:'record.signed',version:1,payload:valid})}finally{channel.close()}
  },{key:actors.teacher.key,student:actors.student.pubkey,teacher:actors.teacher.pubkey,relay:runtime.relayUrl})
  await student.getByRole('button',{name:'我的病历',exact:true}).click()
  await expect(student.getByText('SYNTHETIC_VALID_RECORD',{exact:false})).toBeVisible()
  await expect(student.getByText('TAMPERED_RECORD_MUST_NOT_DISPLAY',{exact:false})).toHaveCount(0)
  expect(await stored(student,'student-records')).toHaveLength(1)
})
test('emergency screening interrupts collection before any consultation can be sent',async({people})=>{
  const page=people.student.page;await role(page,'学生')
  await page.getByRole('button',{name:'开始采集',exact:true}).click()
  await page.getByRole('button',{name:'开始采集',exact:true}).click()
  await page.getByRole('textbox',{name:'用输入法的语音输入，或直接打字'}).fill('胸口压着疼，出冷汗')
  await page.getByRole('button',{name:'加入这一句',exact:true}).click()
  await expect(page.getByText(/请立即就医|请立即去医院|请立即拨打/).first()).toBeVisible()
  await expect(page.getByRole('button',{name:'确认发送',exact:true})).toHaveCount(0)
  expect(await stored(people.teacher.page,'consult-package')).toHaveLength(0)
})

