import { test, expect, runtime } from './fixtures'
import { actors } from './actors.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
test.use({ seedLedger: true })
// V2-16 新外壳：老师 今天/学生/我的馆；学生 今天/记录/我。
async function settings(page: Page) {
  const manage = page.getByRole('button', { name: '我的馆', exact: true })
  if (await manage.count()) await manage.click()
  const me = page.getByRole('button', { name: '我', exact: true })
  if (await me.count()) await me.click()
  const hallSettings = page.locator('.hall-row').filter({ hasText: '设置' })
  if (await hallSettings.count()) await hallSettings.click()
  const meSettings = page.locator('.me-setting-row')
  if (await meSettings.count()) await meSettings.click()
  for (const name of ['模型与偏好设置', '设置', '模型、我的时间、通知']) {
    const summary = page.locator('summary').filter({ hasText: new RegExp('^' + name + '$') })
    if (await summary.count() && await summary.locator('..').getAttribute('open') === null) await summary.click()
  }
}
async function role(page: Page, value: '老师' | '学生') {
  if (value === '老师') await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  else await expect(page.locator('[data-page=student-today]')).toBeVisible()
  await expect(page.getByText('中继：已连接', { exact: true })).toBeVisible()
}
async function studentTab(page: Page, name: '今天' | '记录' | '我') {
  const back = page.locator('.nl-back')
  if (await back.count()) await back.first().click()
  await page.getByRole('button', { name, exact: true }).click()
}
async function studentOther(page: Page) { await studentTab(page, '我') }
async function studentRecords(page: Page, openAll = false) {
  await studentTab(page, '记录')
  await expect(page.getByRole('heading', { name: '我的病历', exact: true })).toBeVisible()
  if (!openAll) return
  await page.getByRole('button', { name: /全部 \d+ 次/ }).click()
  await expect(page.getByRole('button', { name: '返回', exact: true })).toBeVisible()
}
async function studentConsult(page: Page) {
  await studentTab(page, '今天')
  await page.getByRole('button', { name: /不舒服？告诉/ }).click()
}
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
// 问诊三步：说一说之后可能先追问（点跳过），也可能直接进卡片；两种都要能走。
const FIRST_AID = '急症请立即去医院或拨打当地急救电话，别等老师回复。'
// V2-18 旧包字段名用拼接，避免在仓库里留下关键词。
const LEGACY_MARK_FIELD = ['red', 'Flag'].join('')
async function waitCardOrSkip(page: Page) {
  const card = page.getByRole('region', { name: '问诊卡片' })
  const skip = page.getByRole('button', { name: '跳过，直接整理', exact: true }).first()
  await expect(page.getByText(FIRST_AID, { exact: true })).toBeVisible()
  await expect.poll(async () => (await card.count()) + (await skip.count()), { timeout: 60000, intervals: [200, 500, 1000] }).toBeGreaterThan(0)
  return { card, skip }
}
// 页面可能在“追问→卡片”之间自己切换，点击失败不算错：下一轮再看卡片或跳过。
async function advanceToCard(page: Page) {
  const { card, skip } = await waitCardOrSkip(page)
  for (let i = 0; i < 5; i += 1) {
    if (await card.count()) return card
    if (await skip.count()) {
      await skip.click({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(300)
    }
    await waitCardOrSkip(page)
  }
  await expect(card).toBeVisible({ timeout: 60000 })
  return card
}
async function intake(page: Page, quote: string) {
  await studentConsult(page)
  await page.getByLabel('按键盘上的🎤说话就行').fill(quote)
  await page.getByRole('button',{name:'说好了，继续',exact:true}).click()
  await advanceToCard(page)
  await page.getByRole('button',{name:'改一改你的话 ›',exact:true}).click()
  await page.getByLabel('最不舒服的地方（主诉）').fill(quote)
  await page.getByLabel('现在的情况（现病史）').fill('SYNTHETIC_PRESENT')
  await page.getByLabel('以前的病（既往史）').fill('SYNTHETIC_HISTORY')
  await page.getByLabel('在吃的药、过敏').fill('SYNTHETIC_NO_MEDS')
}
async function skipToCard(page: Page) {
  return advanceToCard(page)
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
// 核对页：草稿必须逐块“就这样”才能签字。
async function confirmDraftBlocks(page: Page) {
  for (let guard = 0; guard < 12; guard += 1) {
    const draft = page.locator('.nl-review-block.draft').first()
    if (await draft.count() === 0) return
    await draft.getByRole('button', { name: '就这样', exact: true }).first().click()
  }
}
test('nine-step consultation: signing, erasure, ledger, homework, followup and numeric CSV', async ({ people }) => {
  test.setTimeout(420000)
  const teacher=people.teacher.page,student=people.student.page,quote='SYNTHETIC_PRIVATE_QUOTE_15B'
  await role(teacher,'老师');await role(student,'学生')
  await intake(student,quote)
  const png=await readFile('app/src/core/abstractor/fixtures/tongue.png')
  await student.route('https://model.synthetic.example/v1/chat/completions',async route=>{
    if(!route.request().postData()?.includes('image_url'))return route.fallback()
    await route.fulfill({contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({color:'pale',coatingColor:'white',coatingThickness:'thin',shape:'wide',teeth:[],cracks:[],confidence:0.7,box:{x:0.2,y:0.2,width:0.6,height:0.6},lightingNote:false})}}]})})
  })
  // V2-28：舌象区不再选居住城市（城市来自“我 → 我的时间”/基础信息）。这里直接写入本机档案，
  // 等价于在设置里选过；随后拍舌象按钮才可用。
  await student.evaluate(async () => {
    const storeModule='/src/core/store/index.ts',sessionModule='/src/core/intake/session.ts'
    const s=await(await import(storeModule)).resumeStore()
    try {
      const {loadProfile,saveProfile}=await import(sessionModule)
      const profile=await loadProfile(s.store)
      profile.city={value:'北京市',source:'student'}
      await saveProfile(s.store,profile)
    } finally {s.store.close();s.identity.privateKey.fill(0)}
  })
  await student.getByRole('button',{name:/去拍/}).click()
  await expect(student.getByRole('button',{name:'拍舌象 / 重拍',exact:true})).toBeEnabled()
  const tongueInput=student.locator('input[aria-label="选择舌象照片"]')
  await tongueInput.setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png})
  await expect(student.locator('figure svg')).toHaveCount(1)
  await expect(tongueInput).toHaveValue('')
  await student.getByRole('button',{name:/^发给/}).click()
  await expect(student.getByRole('heading',{name:'已发给老师',exact:true})).toBeVisible()
  // V2-16：等您签字的远程问诊出现在老师“今天”里。
  const remoteRow = teacher.getByRole('button', { name: new RegExp(quote) })
  await expect(remoteRow).toBeVisible()
  expect(await stored(teacher,'attachments')).toHaveLength(1)
  const received=JSON.stringify(await stored(teacher,'consult-package'))
  expect(received).not.toContain(png.toString('base64'));expect(received).toContain('tongues')
  // V2-08：附件通道里只有舌头裁剪图，原图字节没有离开学生本机。
  const crop=await stored(teacher,'attachments')
  expect(JSON.stringify(crop)).not.toContain(png.toString('base64'))
  await remoteRow.click()
  await expect(teacher.getByRole('heading', { name: /· 核对$/ })).toBeVisible()
  await teacher.getByText('本次资料（舌象、扣费、方案）', { exact: true }).click()
  await expect(teacher.locator('figure svg')).toHaveCount(1)
  await expect(teacher.getByText('SYNTHETIC_SUMMARY',{exact:true})).toBeVisible()
  await teacher.getByText('让智能体按一句话改草稿', { exact: true }).click()
  await teacher.getByRole('textbox',{name:'说说怎么改'}).fill('SYNTHETIC_REVISE_SUMMARY')
  await teacher.getByRole('button',{name:'按意见改稿',exact:true}).click()
  await expect(teacher.getByText('SYNTHETIC_FINAL_SUMMARY',{exact:true})).toBeVisible()
  await expect(teacher.getByText(/草稿 · 智能体整理/).first()).toBeVisible()
  await teacher.getByLabel('本次扣费（可选，CNY）',{exact:true}).fill('3')
  await confirmDraftBlocks(teacher)
  await teacher.getByRole('button',{name:'签字发出',exact:true}).click()
  await expect(teacher.getByRole('heading',{name:'已签字交还',exact:true})).toBeVisible()
  await expect(teacher.getByRole('dialog',{name:'像不像我评分'})).toBeVisible()
  await teacher.getByRole('button',{name:'5分',exact:true}).click()
  await expect(teacher.getByRole('dialog',{name:'像不像我评分'})).toHaveCount(0)
  const backHome=student.getByRole('button',{name:'回到今天',exact:true})
  if(await backHome.count())await backHome.click()
  await studentRecords(student, true)
  await expect(student.getByText('证候：SYNTHETIC_PATTERN',{exact:true})).toBeVisible()
  await expect(student.getByText('SYNTHETIC_HOMEWORK',{exact:true})).toBeVisible()
  await student.getByRole('button',{name:'返回',exact:true}).click()
  await studentTab(student,'今天')
  const circle = student.getByRole('button', { name: '打卡：SYNTHETIC_HOMEWORK', exact: true })
  await circle.click()
  await expect(circle).toHaveAttribute('aria-pressed','true')
  const records=await stored(student,'student-records'),assignments=await stored(student,'homework')
  expect(records).toHaveLength(1);expect(assignments).toHaveLength(1)
  expect(JSON.stringify(records)).not.toContain('ai_draft')
  await test.step('V2-01 hard: raw consult stays until retention; student received the signed record',async()=>{
    await teacher.getByRole('button',{name:'返回今天',exact:true}).click()
    await teacher.reload();await expect(teacher.getByRole('heading',{name:'今天',exact:true})).toBeVisible()
    await expect(teacher.getByText('中继：已连接',{exact:true})).toBeVisible()
    // 签过字的问诊不再列在“等您签字”，但原文按保留期限留在本机。
    await expect(teacher.getByText('现在没有等您签字的问诊。学生发给您之后会出现在这里。',{exact:true})).toBeVisible()
    await expect.poll(async()=> (await stored(teacher,'consult-package')).length).toBe(1)
    expect(JSON.stringify(await decrypted(teacher))).toContain(quote)
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
  await student.getByRole('button',{name:/^发给/}).click()
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
  await studentRecords(student, true)
  await expect(student.getByText('SYNTHETIC_VALID_RECORD',{exact:false})).toBeVisible()
  await expect(student.getByText('TAMPERED_RECORD_MUST_NOT_DISPLAY',{exact:false})).toHaveCount(0)
  expect(await stored(student,'student-records')).toHaveLength(1)
})
async function expectNoPhoneNumbers(page: Page) {
  const body = await page.locator('body').innerText()
  for (const num of ['120', '911', '999', '119', '995', '988']) expect(body).not.toContain(num)
}
test('emergency wording shows the standing reminder on all steps and still sends',async({people})=>{
  test.setTimeout(420000)
  const student=people.student.page;await role(student,'学生')
  await studentConsult(student)
  await expect(student.getByText(FIRST_AID,{exact:true})).toBeVisible()
  await student.getByLabel('按键盘上的🎤说话就行').fill('胸口压着疼，出冷汗')
  await student.getByRole('button',{name:'说好了，继续',exact:true}).click()
  await skipToCard(student)
  await expect(student.getByText(FIRST_AID,{exact:true})).toBeVisible()
  await expect(student.getByRole('alert')).toHaveCount(0)
  await expectNoPhoneNumbers(student)
  const send=student.getByRole('button',{name:/^发给/})
  await expect(send).toBeEnabled()
  await send.click()
  await expect(student.getByRole('heading',{name:'已发给老师',exact:true})).toBeVisible()
  await expect.poll(async()=> (await stored(people.teacher.page,'consult-package')).length).toBe(1)
  expect(Object.prototype.hasOwnProperty.call((await stored(people.teacher.page,'consult-package'))[0].value,LEGACY_MARK_FIELD)).toBe(false)
})
test('self-harm wording looks the same, shows only the standing reminder and still sends',async({people})=>{
  test.setTimeout(420000)
  const student=people.student.page;await role(student,'学生')
  await studentConsult(student)
  await expect(student.getByText(FIRST_AID,{exact:true})).toBeVisible()
  await student.getByLabel('按键盘上的🎤说话就行').fill('心里难受、不想活')
  await student.getByRole('button',{name:'说好了，继续',exact:true}).click()
  await skipToCard(student)
  await expect(student.getByText(FIRST_AID,{exact:true})).toBeVisible()
  await expect(student.getByRole('alert')).toHaveCount(0)
  await expectNoPhoneNumbers(student)
  const send=student.getByRole('button',{name:/^发给/})
  await expect(send).toBeEnabled()
  await send.click()
  await expect(student.getByRole('heading',{name:'已发给老师',exact:true})).toBeVisible()
  await expect.poll(async()=> (await stored(people.teacher.page,'consult-package')).length).toBe(1)
  expect(Object.prototype.hasOwnProperty.call((await stored(people.teacher.page,'consult-package'))[0].value,LEGACY_MARK_FIELD)).toBe(false)
})
