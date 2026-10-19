import { test, expect, runtime } from './fixtures'
import { actors } from './actors.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
test.use({ seedLedger: true })
async function settings(page: Page) {
  const manage=page.getByRole('button',{name:'管理',exact:true});if(await manage.count())await manage.click()
  const summary = page.locator('summary').filter({ hasText: /^设置$/ })
  if (await summary.locator('..').getAttribute('open') === null) await summary.click()
}
async function role(page:Page,value:'老师'|'学生') {await expect(page.getByRole('heading',{name:value==='老师'?'今天':'镜子',exact:true})).toBeVisible();await expect(page.getByText('中继：已连接',{exact:true})).toBeVisible()}
// 学生端三页：其他页内的入口。
async function studentOther(page: Page) { await page.getByRole('button',{name:'其他',exact:true}).click() }
async function studentSettings(page: Page) { await studentOther(page); await settings(page) }
async function studentRecords(page: Page) { await studentOther(page); await page.getByRole('button',{name:'我的病历',exact:true}).click() }
async function studentHomework(page: Page) { await studentOther(page); await page.getByRole('button',{name:'今日作业',exact:true}).click() }
async function stored(page: Page, collection: string) {
  return page.evaluate(async name => {
    const module='/src/core/store/index.ts', { resumeStore }=await import(module), session=await resumeStore()
    try { return (await session.store.list(name)).map((row: any) => ({ key:row.key, value:row.value instanceof Uint8Array ? [...row.value] : row.value })) }
    finally { session.store.close();session.identity.privateKey.fill(0) }
  }, collection)
}
async function book(page: Page) {
  return page.evaluate(async ({teacher,student}) => {
    const storePath='/src/core/store/index.ts', syncPath='/src/core/ledger/sync.ts'
    const { resumeStore }=await import(storePath), session=await resumeStore(), { createLedgerSync }=await import(syncPath)
    const sync=createLedgerSync({ identity:session.identity,store:session.store,send:async()=>{throw Error('read only')} })
    try { const v=await sync.view(teacher,student);return { balance:v.balance,code:v.code } }
    finally { await sync.close();session.store.close();session.identity.privateKey.fill(0) }
  }, {teacher:actors.teacher.pubkey,student:actors.student.pubkey})
}
async function intake(page: Page, quote: string) {
  await page.getByRole('button',{name:'问诊',exact:true}).click()
  await page.getByLabel('按键盘上的🎤说话就行').fill(quote)
  await page.getByRole('button',{name:'发送',exact:true}).click()
  for(let i=0;i<3;i++) { const skip=page.getByRole('button',{name:'跳过',exact:true}).first(); try { await skip.waitFor({state:'visible',timeout:10000}) } catch { break } await skip.click() }
  await expect(page.getByRole('button',{name:'发给老师',exact:true})).toBeVisible()
  await page.getByLabel('最不舒服的地方（主诉）').fill(quote)
  await page.getByLabel('现在的情况（现病史）').fill('SYNTHETIC_PRESENT')
  await page.getByLabel('以前的病（既往史）').fill('SYNTHETIC_HISTORY')
  await page.getByLabel('在吃的药、过敏').fill('SYNTHETIC_NO_MEDS')
}
async function decrypted(page: Page) {
  return page.evaluate(async () => {
    const module='/src/core/store/database.ts', {DEFAULT_DATABASE}=await import(module)
    const db:IDBDatabase=await new Promise((resolve,reject)=>{const request=indexedDB.open(DEFAULT_DATABASE,1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
    try {
      const rows:any[]=await new Promise((resolve,reject)=>{const request=db.transaction('records','readonly').objectStore('records').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
      return rows.map(record=>({collection:record.c,value:record.v instanceof Uint8Array?[...record.v]:record.v}))
    } finally {db.close()}
  })
}
test('nine-step consultation: signing, erasure, ledger, homework, followup and numeric CSV', async ({ people }) => {
  test.setTimeout(240000)
  const teacher=people.teacher.page,student=people.student.page,quote='SYNTHETIC_PRIVATE_QUOTE_15B'
  await role(teacher,'老师');await role(student,'学生')
  await teacher.getByRole('button',{name:'远程',exact:true}).click()
  await intake(student,quote)
  const png=await readFile('app/src/core/abstractor/fixtures/tongue.png')
  await student.route('https://model.synthetic.example/v1/chat/completions',async route=>{
    if(!route.request().postData()?.includes('image_url'))return route.fallback()
    await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({color:'pale',coatingColor:'white',coatingThickness:'thin',shape:'wide',teeth:[],cracks:[],confidence:0.7,box:{x:0.2,y:0.2,width:0.6,height:0.6},lightingNote:false})}}]})})
  })
  await student.getByLabel('舌象记录的居住城市').selectOption('北京市')
  await expect(student.getByRole('button',{name:'拍舌象 / 重拍',exact:true})).toBeEnabled()
  await student.locator('input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png})
  await expect(student.locator('figure svg')).toHaveCount(1)
  await expect(student.locator('input[type=file]')).toHaveValue('')
  await student.getByRole('button',{name:'发给老师',exact:true}).click()
  await expect(student.getByRole('heading',{name:'已发给老师',exact:true})).toBeVisible()
  await expect(teacher.getByRole('heading',{name:quote,exact:true})).toBeVisible()
  expect(await stored(teacher,'attachments')).toHaveLength(1)
  const received=JSON.stringify(await stored(teacher,'consult-package'))
  expect(received).not.toContain(png.toString('base64'));expect(received).toContain('tongues')
  // V2-08：附件通道里只有舌头裁剪图，原图字节没有离开学生本机。
  const crop=await stored(teacher,'attachments')
  expect(JSON.stringify(crop)).not.toContain(png.toString('base64'))
  await teacher.getByRole('button',{name:'打开问诊',exact:true}).click()
  await expect(teacher.locator('figure svg')).toHaveCount(1)
  await expect(teacher.getByText('SYNTHETIC_SUMMARY',{exact:true})).toBeVisible()
  await teacher.getByRole('textbox',{name:'说说怎么改'}).fill('SYNTHETIC_REVISE_SUMMARY')
  await teacher.getByRole('button',{name:'按意见改稿',exact:true}).click()
  await expect(teacher.getByText('SYNTHETIC_FINAL_SUMMARY',{exact:true})).toBeVisible()
  await expect(teacher.getByText('AI 草稿',{exact:true}).first()).toBeVisible()
  await teacher.getByLabel('本次扣费（可选，CNY）',{exact:true}).fill('3')
  await teacher.getByRole('button',{name:'签字发出',exact:true}).click()
  await expect(teacher.getByRole('heading',{name:'已签字交还',exact:true})).toBeVisible()
  await expect(teacher.getByRole('dialog',{name:'像不像我评分'})).toBeVisible()
  await teacher.getByRole('button',{name:'5分',exact:true}).click()
  await expect(teacher.getByRole('dialog',{name:'像不像我评分'})).toHaveCount(0)
  await studentRecords(student)
  await expect(student.getByText('证候：SYNTHETIC_PATTERN',{exact:true})).toBeVisible()
  await expect(student.getByText('SYNTHETIC_HOMEWORK',{exact:true})).toBeVisible()
  await student.getByRole('button',{name:'返回',exact:true}).click()
  await studentHomework(student)
  await student.getByRole('button',{name:'已完成',exact:true}).click()
  // 按钮上的“今日已完成”与打卡用同一个 checkinDay（本地 00:00–00:59 归前一天），任何时刻都该变成已完成。
  await expect(student.getByRole('button',{name:'今日已完成 ✓',exact:true})).toBeDisabled()
  await student.getByRole('button',{name:'返回',exact:true}).click()
  const records=await stored(student,'student-records'),assignments=await stored(student,'homework')
  expect(records).toHaveLength(1);expect(assignments).toHaveLength(1)
  expect(JSON.stringify(records)).not.toContain('ai_draft')
  await test.step('V2-01 hard: raw consult stays until retention; student received the signed record',async()=>{
    await teacher.getByRole('button',{name:'返回首页',exact:true}).click()
    await teacher.reload();await expect(teacher.getByRole('heading',{name:'今天',exact:true})).toBeVisible()
    await expect(teacher.getByText('中继：已连接',{exact:true})).toBeVisible()
    await teacher.getByRole('button',{name:'远程',exact:true}).click()
    await expect(teacher.locator('.inbox-card').first()).toBeVisible()
    await expect.poll(async()=> (await stored(teacher,'consult-package')).length).toBe(1)
    // V2-01：签字只发送、不再多步销毁；原文保留，由 V2-05 保留期限统一删除。
    expect(JSON.stringify(await decrypted(teacher))).toContain(quote)
    await teacher.getByRole('button',{name:'返回',exact:true}).click()
  })
  // V2-01：账本余额/对账码由 ledger 自己的测试覆盖；本 e2e 只验证完整问诊链路（签字/病历/作业/CSV）。
  await test.step('hard: teacher and student both have a ledger book on file',async()=>{
    const t=await book(teacher),s=await book(student)
    expect(t.balance).not.toBeNull();expect(t.code).toBe(s.code)
  })
  const exportRequests:string[]=[]
  const observe=(request:any)=>{if(/^https?:/.test(request.url()))exportRequests.push(request.url())}
  teacher.on('request',observe)
  await settings(teacher)
  const downloadPromise=teacher.waitForEvent('download')
  await teacher.getByRole('button',{name:'导出试点指标',exact:true}).click()
  const csv=await readFile((await (await downloadPromise).path())!,'utf8'),lines=csv.trim().split(/\r?\n/),cells=lines[1].split(',')
  if (!process.env.CI) await writeFile(path.resolve('.cache/e2e/pilot-synthetic-local.csv'),csv)
  teacher.off('request',observe);expect(exportRequests).toHaveLength(0)
  expect(lines).toHaveLength(2);expect(cells).toHaveLength(6);expect(lines[0].includes('homework_adherence')).toBe(true);expect(cells[0]===records[0].value.id.slice(0,8)).toBe(true)
  expect(Number(cells[1])>0).toBe(true);expect(Math.abs(Number(cells[2])-1/6)<0.00001).toBe(true);expect(Number(cells[3])===3/8).toBe(true);expect(cells[4]==='5').toBe(true)
  for(const secret of [quote,actors.teacher.pubkey,actors.student.pubkey,'SYNTHETIC_FINAL_SUMMARY','SYNTHETIC_HOMEWORK'])expect(!csv.includes(secret)).toBe(true)
  await intake(student,'SYNTHETIC_FOLLOWUP')
  await student.getByRole('button',{name:'发给老师',exact:true}).click()
  await expect(student.getByRole('heading',{name:'已发给老师',exact:true})).toBeVisible()
  // V2-01：第一份问诊包不再销毁，第二份追问会并存（删除由 V2-05 保留期限处理）。
  await expect.poll(async()=> (await stored(teacher,'consult-package')).length).toBe(2)
  const packages=(await stored(teacher,'consult-package')).map((row:any)=>row.value)
  const followup=packages.find((value:any)=>Array.isArray(value.history)&&value.history.length===1)??packages[0]
  expect(followup.history).toHaveLength(1);expect(JSON.parse(followup.history[0]).id).toBe(records[0].key)
})

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
  await studentRecords(student)
  await expect(student.getByText('SYNTHETIC_VALID_RECORD',{exact:false})).toBeVisible()
  await expect(student.getByText('TAMPERED_RECORD_MUST_NOT_DISPLAY',{exact:false})).toHaveCount(0)
  expect(await stored(student,'student-records')).toHaveLength(1)
})
test('emergency prompts inline without phone numbers and still sends with redFlag',async({people})=>{
  const student=people.student.page;await role(student,'学生')
  await student.getByRole('button',{name:'问诊',exact:true}).click()
  await student.getByLabel('按键盘上的🎤说话就行').fill('胸口压着疼，出冷汗')
  await student.getByRole('button',{name:'发送',exact:true}).click()
  await expect(student.getByText('您说的情况需要尽快去医院，请不要耽误',{exact:true})).toBeVisible()
  const body=await student.locator('body').innerText()
  for(const num of ['120','911','999','119','995','988']) expect(body).not.toContain(num)
  for(let i=0;i<3;i++){const skip=student.getByRole('button',{name:'跳过',exact:true}).first();try{await skip.waitFor({state:'visible',timeout:10000})}catch{break};await skip.click()}
  await student.getByRole('button',{name:'发给老师',exact:true}).click()
  await expect(student.getByRole('heading',{name:'已发给老师',exact:true})).toBeVisible()
  await expect.poll(async()=> (await stored(people.teacher.page,'consult-package')).length).toBe(1)
  expect((await stored(people.teacher.page,'consult-package'))[0].value.redFlag).toEqual({hit:true,crisis:false})
})
test('self-harm shows only the crisis hotline and marks crisis redFlag',async({people})=>{
  const student=people.student.page;await role(student,'学生')
  await student.getByRole('button',{name:'问诊',exact:true}).click()
  await student.getByLabel('按键盘上的🎤说话就行').fill('不想活了')
  await student.getByRole('button',{name:'发送',exact:true}).click()
  await expect(student.getByText('你并不孤单',{exact:false})).toBeVisible()
  const body=await student.locator('body').innerText()
  for(const num of ['120','911','999','119','995']) expect(body).not.toContain(num)
  for(let i=0;i<3;i++){const skip=student.getByRole('button',{name:'跳过',exact:true}).first();try{await skip.waitFor({state:'visible',timeout:10000})}catch{break};await skip.click()}
  await student.getByRole('button',{name:'发给老师',exact:true}).click()
  await expect(student.getByRole('heading',{name:'已发给老师',exact:true})).toBeVisible()
  await expect.poll(async()=> (await stored(people.teacher.page,'consult-package')).length).toBe(1)
  expect((await stored(people.teacher.page,'consult-package'))[0].value.redFlag).toEqual({hit:true,crisis:true})
})
