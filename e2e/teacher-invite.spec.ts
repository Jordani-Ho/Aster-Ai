import {expect,runtime,test,mockModel,connectModel} from './fixtures'

async function openTeacherSettings(page:import('@playwright/test').Page){
  // 已经停在设置页时，先按返回回到“我的馆”，底部标签才在。
  const back=page.locator('.nl-back')
  if(await back.count())await back.first().click()
  await page.getByRole('navigation',{name:'老师底部标签'}).getByRole('button',{name:'我的馆',exact:true}).click()
  await page.locator('.hall-row').filter({hasText:'设置'}).click()
}

async function openStudentSettings(page:import('@playwright/test').Page){
  const back=page.locator('.nl-back')
  if(await back.count())await back.first().click()
  await page.getByRole('navigation',{name:'学生底部标签'}).getByRole('button',{name:'我',exact:true}).click()
  await page.locator('.me-setting-row').click()
}

test('V2-37 核心学生推荐老师登记、开馆邀学生；普通老师晋升后才出现推荐入口',async({people,browser})=>{
  test.setTimeout(180000)
  const founder=people.student.page,student=founder
  // 学生手机扫核心登记码，仍留在学生端。
  await founder.evaluate(()=>{location.hash='#core=SYNTHETIC_CORE_TOKEN'})
  await expect(founder.locator('[data-page=student-today]')).toBeVisible()
  await openStudentSettings(founder)
  const reason=founder.getByLabel('为什么推荐这位老师',{exact:true})
  await expect(reason).toBeVisible()
  await reason.fill('合成推荐理由：愿意长期陪伴学生。')
  await founder.getByRole('button',{name:'推荐一位老师',exact:true}).click()
  const recommendation=founder.getByLabel('邀请链接',{exact:true})
  await expect(recommendation).toBeVisible()
  const teacherLink=await recommendation.inputValue()

  const newTeacherContext=await browser.newContext({viewport:{width:375,height:812},baseURL:runtime.baseURL})
  try{
    await mockModel(newTeacherContext)
    const newTeacher=await newTeacherContext.newPage()
    await newTeacher.goto('/')
    await expect(newTeacher.getByRole('heading',{name:'您是老师还是学生？'})).toBeVisible()
    // 页面已打开，推荐链接只改变 fragment。
    await newTeacher.goto(teacherLink)
    await expect(newTeacher.getByText('建馆 · 第 1 / 5 步',{exact:true})).toBeVisible()
    await connectModel(newTeacher)
    await expect(newTeacher.getByRole('heading',{name:'先登记您这位老师',exact:true})).toBeVisible()
    await expect(newTeacher.getByLabel('登记口令',{exact:true})).toHaveCount(0)
    await newTeacher.getByLabel('学生怎么称呼您',{exact:true}).fill('合成新老师')
    await newTeacher.getByRole('button',{name:'登记，下一步',exact:true}).click()
    await expect(newTeacher.getByRole('heading',{name:'给您的馆起个名',exact:true})).toBeVisible()
    await newTeacher.getByLabel('馆名',{exact:true}).fill('合成新老师的馆')
    await newTeacher.getByLabel('一句介绍',{exact:true}).fill('合成介绍')
    await newTeacher.getByRole('button',{name:'就用这个名字',exact:true}).click()
    for(const label of ['模板','排班','邀约方式','药材库','保留期限','模型']){if(label==='药材库')await newTeacher.getByLabel('不备药',{exact:true}).check();await newTeacher.getByRole('button',{name:'就这样，保存'+label,exact:true}).click()}
    await newTeacher.getByRole('button',{name:'开馆',exact:true}).click()
    await expect(newTeacher.getByRole('heading',{name:'请第一位来面诊的学生当面扫码',exact:true})).toBeVisible()
    await newTeacher.locator('details.op-link-details > summary').click()
    const firstInvite=newTeacher.getByLabel('邀请链接',{exact:true})
    await expect(firstInvite).toBeVisible()
    const studentLink=await firstInvite.inputValue()

    // 真实中继的合成学生接受邀请；老师端收到名册后建馆流程完成。
    // 不刷新已连接的学生页面，直接换邀请 fragment。
    await student.evaluate(hash=>{location.hash=hash},new URL(studentLink).hash)
    const welcome=student.getByRole('button',{name:'开始使用',exact:true})
    await expect(welcome).toBeVisible({timeout:20000})
    await welcome.click()
    // 这位合成学生已在发起人馆里填过基础信息，接受第二位老师的邀请后直接进首页。
    try{await expect(student.locator('[data-page=student-today]')).toBeVisible({timeout:20000})}
    catch(cause){throw Error('学生接受新老师邀请后没进首页，页面显示：'+(await student.locator('body').innerText()).replace(/\s*\n\s*/g,' | ').slice(0,700),{cause})}
    try{await expect(newTeacher.getByRole('button',{name:'开始面诊',exact:true})).toBeVisible({timeout:40000});await newTeacher.getByRole('button',{name:'先不面诊，进工作台',exact:true}).click();await expect(newTeacher.getByRole('heading',{name:'今天',exact:true})).toBeVisible()}
    catch(cause){
      const peek=(page:import('@playwright/test').Page,names:string[])=>page.evaluate(async list=>{const m='/src/core/store/index.ts',{resumeStore}=await import(m),s=await resumeStore();try{const out:Record<string,number>={};for(const n of list)out[n]=(await s.store.list(n)).length;const role=await s.store.get('settings','role');return {...out,role:JSON.stringify(role)}}finally{s.store.close();s.identity.privateKey.fill(0)}},names)
      throw Error('新老师没自动进“今天”：老师端 '+JSON.stringify(await peek(newTeacher,['teacher-students']))+'；学生端 '+JSON.stringify(await peek(student,['student-roster-pending','student-roster-joined']))+'；老师页面：'+(await newTeacher.locator('body').innerText()).replace(/\s*\n\s*/g,' | ').slice(0,400),{cause})
    }
    await openTeacherSettings(newTeacher)
    await expect(newTeacher.getByRole('button',{name:'推荐一位老师',exact:true})).toHaveCount(0)

    // 核心成员签发晋升链接；同一位老师兑换后，核心操作才出现。
    await openStudentSettings(founder)
    await founder.getByRole('button',{name:'邀请已登记老师成为核心成员',exact:true}).click()
    const promotion=founder.getByLabel('邀请链接',{exact:true})
    await expect(promotion).toBeVisible()
    // 已打开设置的老师只改变 fragment，也应立即完成晋升。
    await newTeacher.goto(await promotion.inputValue())
    await expect(newTeacher.getByRole('button',{name:'推荐一位老师',exact:true})).toBeVisible()
    await expect(newTeacher.getByText('已成为核心成员，现在可以推荐老师。',{exact:true})).toBeVisible()
  }finally{await newTeacherContext.close()}
})
