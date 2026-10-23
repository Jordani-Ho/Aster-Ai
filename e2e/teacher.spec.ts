import {test,expect,runtime} from './fixtures'
import type {Page} from '@playwright/test'
import path from 'node:path'
// V2-16 新界面：老师 今天/学生/我的馆；面诊与远程核对都是全屏流程。
async function consultations(page:Page){
 await page.evaluate(async relay=>{
  const a='/src/core/store/index.ts',b='/src/core/record/in-person.ts',c='/src/core/transport/index.ts',d='/src/core/inbox/index.ts'
  const session=await(await import(a)).resumeStore(),teachers=await session.store.get('settings','teachers'),{startInPersonEncounter}=await import(b),{createTransport}=await import(c),{sendConsultPackage}=await import(d)
  const channel=createTransport({privateKey:session.identity.privateKey,relays:[relay],onMessage:()=>{}});channel.start()
  try{for(const [i,text] of ['SYNTHETIC_NORMAL','胸痛伴出汗'].entries()){
    const encounter=startInPersonEncounter({teacher:teachers[0],student:session.identity.publicKey,id:(i?'b':'a').repeat(32)});encounter.kind='remote_async';encounter.intake.chiefComplaint={value:text,source:'student'}
    await sendConsultPackage((recipient:any,envelope:any)=>channel.send(recipient,envelope),{encounter,history:[],attachments:[]})
  }}finally{channel.close();session.store.close();session.identity.privateKey.fill(0)}
 },runtime.relayUrl)
}
async function picture(page:Page,name:string){if(!process.env.CI)await page.screenshot({path:path.resolve('docs/screenshots/teacher-'+name+'-375.png'),fullPage:false});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
async function confirmBlocks(page:Page){
 for(let guard=0;guard<12;guard+=1){
  const draft=page.locator('.nl-review-block.draft').first()
  if(await draft.count()===0)return
  await draft.getByRole('button',{name:'就这样',exact:true}).first().click()
 }
}
async function backToToday(page:Page){
 for(let guard=0;guard<4;guard+=1){const back=page.locator('.nl-back');if(await back.count()===0)break;await back.first().click();await page.waitForTimeout(120)}
 await expect(page.getByRole('heading',{name:'今天',exact:true})).toBeVisible()
}
test('M1-20 four pages: urgent first, three taps to sign, revision stays draft, four 375px screenshots',async({people})=>{
 const teacher=people.teacher.page,student=people.student.page
 await consultations(student)
 // 急症排最前：等您签字第一条就是“胸痛伴出汗”，并标急症。
 const urgent=teacher.getByRole('button',{name:/胸痛伴出汗/})
 await expect(urgent).toBeVisible()
 await expect(urgent).toContainText('急症')
 await picture(teacher,'today')
 await teacher.getByRole('button',{name:'我的馆',exact:true}).click()
 await picture(teacher,'manage')
 await teacher.locator('details.manage-block').filter({hasText:/^钱账/}).locator('summary').click()
 await expect(teacher.getByText('学生连上社区后就会出现在这里；第一次记账时自动建账。',{exact:true})).toBeVisible()
 // 面诊：选学生 → 说一段 → 四格 → 看草稿（这次先不签，留作草稿）
 await teacher.getByRole('button',{name:'今天',exact:true}).click()
 await teacher.getByRole('button',{name:/开始面诊/}).click()
 await teacher.getByRole('button',{name:/学生 1/}).click()
 await teacher.getByLabel('您说，智能体记',{exact:true}).fill('SYNTHETIC_IN_PERSON')
 await teacher.getByRole('button',{name:'整理',exact:true}).click()
 await expect(teacher.getByRole('button',{name:'四诊 ask'})).toContainText('SYNTHETIC_IN_PERSON')
 await picture(teacher,'in-person')
 await teacher.getByRole('button',{name:'说完了，看草稿',exact:true}).click()
 await expect(teacher.getByRole('heading',{name:/· 核对$/})).toBeVisible()
 await backToToday(teacher)
 // 远程：核对页 → 改稿 → 逐块就这样 → 签字发出
 await teacher.getByRole('button',{name:/胸痛伴出汗/}).click()
 await expect(teacher.getByRole('heading',{name:/· 核对$/})).toBeVisible()
 await teacher.getByText('让智能体按一句话改草稿',{exact:true}).click()
 await teacher.getByRole('textbox',{name:'说说怎么改'}).fill('SYNTHETIC_REMOVE_HERB')
 await teacher.getByRole('button',{name:'按意见改稿',exact:true}).click()
 const prescription=teacher.getByRole('region',{name:'方子'})
 await expect(prescription).not.toContainText('SYNTHETIC_HERB ')
 await expect(prescription).toContainText('SYNTHETIC_KEEP')
 await expect(teacher.getByText(/草稿 · /).first()).toBeVisible()
 await picture(teacher,'remote')
 let modelCalls=0;teacher.on('request',req=>{if(req.url().includes('/chat/completions'))modelCalls++})
 await confirmBlocks(teacher)
 await teacher.getByRole('button',{name:'签字发出',exact:true}).click()
 await expect(teacher.getByRole('heading',{name:'已签字交还',exact:true})).toBeVisible()
 expect(modelCalls).toBe(0)
 await expect.poll(()=>student.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return (await s.store.list('student-records')).length}finally{s.store.close();s.identity.privateKey.fill(0)}})).toBe(1)
 const text=await student.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return JSON.stringify(await s.store.list('student-records'))}finally{s.store.close();s.identity.privateKey.fill(0)}})
 expect(text).not.toContain('ai_draft');expect(text).toContain('ai_accepted');expect(text).toContain('SYNTHETIC_KEEP');expect(text).not.toContain('SYNTHETIC_HERB')
})
test('M1-20 in person uses conversational intake, same drafting/revision/signature, keeps local raw until retention',async({people})=>{
 const teacher=people.teacher.page
 await consultations(people.student.page)
 await teacher.getByRole('button',{name:/开始面诊/}).click()
 await teacher.getByRole('button',{name:/学生 1/}).click()
 await expect(teacher.getByLabel('您说，智能体记',{exact:true})).toBeVisible()
 await teacher.getByLabel('您说，智能体记',{exact:true}).fill('SYNTHETIC_FACE_RAW')
 await teacher.getByRole('button',{name:'整理',exact:true}).click()
 // V2 原图不留：面诊直接看本人，不再提供老师拍照落盘入口。
 await expect(teacher.locator('input[type=file]')).toHaveCount(0)
 await teacher.getByRole('button',{name:'说完了，看草稿',exact:true}).click()
 await teacher.getByText('让智能体按一句话改草稿',{exact:true}).click()
 await teacher.getByRole('textbox',{name:'说说怎么改'}).fill('SYNTHETIC_REMOVE_HERB')
 await teacher.getByRole('button',{name:'按意见改稿',exact:true}).click()
 await expect(teacher.getByText('SYNTHETIC_KEEP SYNTHETIC_DOSE',{exact:true})).toBeVisible()
 await confirmBlocks(teacher)
 await teacher.getByRole('button',{name:'签字发出',exact:true}).click()
 await expect(teacher.getByRole('heading',{name:'已签字交还',exact:true})).toBeVisible()
 const result=await teacher.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return {drafts:await s.store.list('in-person-draft'),indices:await s.store.list('teacher-records'),photos:await s.store.list('attachments')}}finally{s.store.close();s.identity.privateKey.fill(0)}})
 expect(result.drafts).toHaveLength(1);expect(JSON.stringify(result.drafts)).toContain('SYNTHETIC_FACE_RAW');expect(result.indices).toHaveLength(1);expect(result.photos).toHaveLength(0)
 const student=people.student.page
 await expect.poll(()=>student.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return (await s.store.list('student-records')).length}finally{s.store.close();s.identity.privateKey.fill(0)}})).toBeGreaterThan(0)
 await student.getByRole('button',{name:'记录',exact:true}).click()
 await expect(student.getByRole('heading',{name:'我的病历',exact:true})).toBeVisible()
 await expect(student.getByAltText('病历照片 1',{exact:true})).toHaveCount(0)
})
test('M1-20 signed care plan reaches student mirror next day with fixed browser clock; self mirror uses same core',async({people})=>{
 const teacher=people.teacher.page,student=people.student.page
 const fixed=new Date(),nextDay=new Date(fixed.getTime()+86400000)
 await teacher.clock.install({time:fixed})
 await student.clock.install({time:fixed})
 // Wait for the initial cache write before preparing this concurrency case.
 await expect(student.getByRole('region',{name:'每日建议'})).toContainText('SYNTHETIC_DAILY')
 let dailyCalls=0;student.on('request',req=>{if(req.url().includes('/chat/completions')&&req.postData()?.includes('学生每日镜子建议'))dailyCalls++})
 await student.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{for(const row of await s.store.list('mirror'))await s.store.delete('mirror',row.key)}finally{s.store.close();s.identity.privateKey.fill(0)};window.dispatchEvent(new Event('aster:data-changed'));window.dispatchEvent(new Event('aster:data-changed'))})
 await expect.poll(()=>student.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return (await s.store.list('mirror')).length}finally{s.store.close();s.identity.privateKey.fill(0)}})).toBe(1)
 expect(dailyCalls).toBe(1)
 await student.reload();await expect(student.getByRole('region',{name:'每日建议'})).toContainText('SYNTHETIC_DAILY')
 expect(dailyCalls).toBe(1)
 await consultations(student)
 await teacher.getByRole('button',{name:/胸痛伴出汗/}).click()
 await teacher.getByText('本次资料（舌象、扣费、方案）',{exact:true}).click()
 await teacher.getByRole('textbox',{name:'调养要点',exact:true}).fill('SYNTHETIC_PLAN_POINT')
 await teacher.getByRole('button',{name:'整理方案',exact:true}).click()
 const plan=teacher.getByRole('article',{name:'调养方案卡片'})
 await expect(plan).toContainText('AI 草稿')
 await expect(plan).toContainText('SYNTHETIC_PLAN_POINT')
 const plans=()=>student.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return await s.store.list('care-plans')}finally{s.store.close();s.identity.privateKey.fill(0)}})
 expect(await plans()).toHaveLength(0)
 let calls=0;teacher.on('request',req=>{if(req.url().includes('/chat/completions'))calls++})
 await teacher.getByRole('button',{name:'确认并签发方案',exact:true}).click()
 await expect(teacher.getByText('调养方案已签发，学生明天的建议会参考它。',{exact:true})).toBeVisible()
 expect(calls).toBe(0)
 await expect.poll(async()=>(await plans()).length).toBe(1)
 await expect(student.getByRole('region',{name:'每日建议'})).toContainText('SYNTHETIC_DAILY')
 await expect(student.getByRole('region',{name:'每日建议'})).not.toContainText('SYNTHETIC_PLAN_POINT')
 await student.clock.setSystemTime(nextDay)
 await student.reload()
 await expect(student.getByRole('region',{name:'每日建议'})).toContainText('SYNTHETIC_PLAN_POINT')
 // 老师自己的方案：同一套签字路径，只是收件人是自己；放在“我的馆 → 我的镜子”。
 await backToToday(teacher)
 await teacher.getByRole('button',{name:'我的馆',exact:true}).click()
 await teacher.locator('details.manage-block').filter({hasText:/^我的镜子/}).locator('summary').click()
 await teacher.getByText('给自己定制调养方案',{exact:true}).click()
 await teacher.getByRole('textbox',{name:'调养要点',exact:true}).fill('SYNTHETIC_PLAN_POINT')
 await teacher.getByRole('button',{name:'整理方案',exact:true}).click()
 await teacher.getByRole('button',{name:'确认并签发方案',exact:true}).click()
 await expect(teacher.getByText('给自己的方案已确认，明天的建议会参考它。',{exact:true})).toBeVisible()
 await teacher.clock.setSystemTime(nextDay);await teacher.reload()
 await teacher.getByRole('button',{name:'我的馆',exact:true}).click()
 await teacher.locator('details.manage-block').filter({hasText:/^我的镜子/}).locator('summary').click()
 await expect(teacher.getByRole('region',{name:'每日建议'})).toContainText('SYNTHETIC_PLAN_POINT')
})
