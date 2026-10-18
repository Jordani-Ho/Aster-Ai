import {test,expect,runtime} from './fixtures'
import type {Page} from '@playwright/test'
import path from 'node:path'
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
test('M1-20 four pages: urgent first, three taps to sign, revision stays draft, four 375px screenshots',async({people})=>{
 const teacher=people.teacher.page,student=people.student.page
 await consultations(student)
 await expect(teacher.locator('.teacher-count')).toContainText('2')
 await expect(teacher.locator('.teacher-card').first()).toContainText('胸痛伴出汗')
 await expect(teacher.locator('.teacher-card').first()).toContainText('急症提醒')
 await picture(teacher,'today')
 await teacher.getByRole('button',{name:'管理',exact:true}).click()
 await teacher.getByText('设置',{exact:true}).click()
 await expect(teacher.getByText('康币账本与对账',{exact:true})).toBeVisible()
 await picture(teacher,'manage')
 await teacher.getByRole('button',{name:'面诊',exact:true}).click()
 await teacher.getByLabel('选择学生').selectOption(people.student.actor.pubkey)
 await teacher.getByRole('button',{name:'新建面诊病历',exact:true}).click()
 await teacher.getByRole('textbox',{name:'用输入法的语音输入，或直接打字'}).fill('SYNTHETIC_IN_PERSON')
 await teacher.getByRole('button',{name:'加入这一句',exact:true}).click()
 await expect(teacher.getByText('主诉：SYNTHETIC_IN_PERSON',{exact:true})).toBeVisible()
 await teacher.getByRole('button',{name:'生成病历',exact:true}).scrollIntoViewIfNeeded()
 await picture(teacher,'in-person')
 // 远程一次，打开一次，签字一次；改稿本身的输入和提交不算签字点按。
 await teacher.getByRole('button',{name:'远程',exact:true}).click()
 await expect(teacher.locator('.inbox-card').first()).toContainText('胸痛伴出汗')
 await expect(teacher.locator('.inbox-card').first()).toContainText('急症提醒')
 await teacher.getByRole('button',{name:'打开问诊',exact:true}).first().click()
 await expect(teacher.getByRole('heading',{name:'病历草稿',exact:true})).toBeVisible()
 await teacher.getByRole('textbox',{name:'说说怎么改'}).fill('SYNTHETIC_REMOVE_HERB')
 await teacher.getByRole('button',{name:'按意见改稿',exact:true}).click()
 const prescription=teacher.locator('.sign-field').filter({has:teacher.getByRole('heading',{name:'方子',exact:true})})
 await expect(prescription).not.toContainText('SYNTHETIC_HERB ')
 await expect(prescription).toContainText('SYNTHETIC_KEEP')
 await expect(prescription).toContainText('AI 草稿')
 await prescription.scrollIntoViewIfNeeded()
 await picture(teacher,'remote')
 let modelCalls=0;teacher.on('request',req=>{if(req.url().includes('/chat/completions'))modelCalls++})
 await teacher.getByRole('button',{name:'签字发出',exact:true}).click()
 await expect(teacher.getByRole('heading',{name:'已签字交还',exact:true})).toBeVisible()
 expect(modelCalls).toBe(0)
 await expect.poll(()=>student.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return (await s.store.list('student-records')).length}finally{s.store.close();s.identity.privateKey.fill(0)}})).toBe(1)
 const text=await student.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return JSON.stringify(await s.store.list('student-records'))}finally{s.store.close();s.identity.privateKey.fill(0)}})
 expect(text).not.toContain('ai_draft');expect(text).toContain('ai_accepted');expect(text).toContain('SYNTHETIC_KEEP');expect(text).not.toContain('SYNTHETIC_HERB')
})

test('M1-20 in person uses conversational intake, same drafting/revision/signature, then erases local raw draft',async({people})=>{
 const teacher=people.teacher.page
 await consultations(people.student.page)
 await expect(teacher.locator('.teacher-count')).toContainText('2')
 await teacher.getByRole('button',{name:'面诊',exact:true}).click()
 await teacher.getByLabel('选择学生').selectOption(people.student.actor.pubkey)
 await teacher.getByRole('button',{name:'新建面诊病历',exact:true}).click()
 await expect(teacher.getByRole('textbox')).toHaveCount(1)
 await teacher.getByRole('textbox').fill('SYNTHETIC_FACE_RAW')
 await teacher.getByRole('button',{name:'加入这一句',exact:true}).click()
 await teacher.getByRole('button',{name:'生成病历',exact:true}).click()
 await teacher.getByRole('textbox',{name:'说说怎么改'}).fill('SYNTHETIC_REMOVE_HERB')
 await teacher.getByRole('button',{name:'按意见改稿',exact:true}).click()
 await expect(teacher.getByText('SYNTHETIC_KEEP SYNTHETIC_DOSE',{exact:true})).toBeVisible()
 await teacher.getByRole('button',{name:'签字发出',exact:true}).click()
 await expect(teacher.getByRole('heading',{name:'已签字交还',exact:true})).toBeVisible()
 const result=await teacher.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return {drafts:await s.store.list('in-person-draft'),indices:await s.store.list('signed-encounters')}}finally{s.store.close();s.identity.privateKey.fill(0)}})
 expect(result.drafts).toEqual([]);expect(JSON.stringify(result.indices)).not.toContain('SYNTHETIC_FACE_RAW');expect(result.indices).toHaveLength(1)
})
