import { chromium, expect } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { root } from './process.mjs'
import { startGatewayFixture } from './gateway-fixture.mjs'
import { startWebApp } from './environment.mjs'

const cache = path.join(root, '.cache/e2e')
await mkdir(cache, { recursive: true })
const browser = await chromium.launch({ headless: true })
async function scenario(mode) {
  const directory = await mkdtemp(path.join(cache, 'core-student-'))
  let gateway, app, studentContext, teacherContext, releaseCore
  try {
    gateway = await startGatewayFixture({ directory, members: [] })
    app = await startWebApp({ gatewayUrl: gateway.url, relayUrl: 'ws://127.0.0.1:1/' })
    studentContext = await browser.newContext()
    const student = await studentContext.newPage()
    const requests = []
    student.on('request', request => requests.push(request.url()))
    if (mode === 'unselected') {
      await student.goto(app.url + '/#core=SYNTHETIC_CORE_TOKEN')
      await expect(student.getByRole('heading',{name:'您是老师还是学生？'})).toBeVisible()
      await expect(student.getByText('已登记为核心成员，现在可以推荐老师。',{exact:true})).toBeVisible()
      const state = await student.evaluate(async () => {
        const s='/src/core/store/index.ts',i='/src/core/teacher-invites.ts'
        const {resumeStore}=await import(s),{coreMemberStatus}=await import(i),session=await resumeStore()
        try { return { role:(await session.store.get('settings','role')) ?? null, status:await coreMemberStatus(session.identity,location.origin) } }
        finally { session.store.close();session.identity.privateKey.fill(0) }
      })
      expect(state).toEqual({role:null,status:{teacher:false,core:true}})
      expect(new URL(student.url()).hash).toBe('')
      return
    }
    await student.goto(app.url)
    await expect(student.getByRole('heading',{name:'您是老师还是学生？'})).toBeVisible()
    await student.evaluate(async () => {
      const s='/src/core/store/index.ts', b='/src/core/basics/index.ts', m='/src/core/llm/personal.ts'
      const {resumeStore}=await import(s),{saveBasics}=await import(b),{savePersonalModel}=await import(m),session=await resumeStore()
      try {
        await session.store.put('settings','role',{role:'student'})
        await savePersonalModel(session.store,{provider:'other',baseUrl:'https://model.synthetic.example/v1',model:'synthetic',apiKey:'SYNTHETIC',testedAt:new Date().toISOString()})
        await saveBasics(session.store,{alias:'合成学生',gender:'other',birthDate:'1990-05-06',birthShichen:null,birthPlace:'北京市',city:'北京市',routine:{wake:'07:00',sleep:'23:00'}})
      } finally { session.store.close();session.identity.privateKey.fill(0) }
    })
    await student.reload()
    await expect(student.locator('[data-page=student-today]')).toBeVisible()
    await student.getByRole('button',{name:'我',exact:true}).click()
    await student.locator('.me-setting-row').click()
    await expect(student.getByRole('button',{name:'推荐一位老师',exact:true})).toHaveCount(0)

    if (mode === 'slow') {
      const pending = new Promise(resolve => { releaseCore = resolve })
      await student.route('**/invite/core-seed', async route => { await pending; await route.continue() })
    }
    const coreLink = app.url + (mode === 'cold' || mode === 'slow' ? '/?cold=1' : '/') + '#core=SYNTHETIC_CORE_TOKEN'
    await student.goto(coreLink)
    if (mode === 'cold' || mode === 'slow') {
      await expect(student.locator('[data-page=student-today]')).toBeVisible()
      releaseCore?.()
      await student.getByRole('button',{name:'我',exact:true}).click()
      await student.locator('.me-setting-row').click()
    }
    const actions=student.getByRole('region',{name:'老师邀请'})
    await expect(actions).toBeVisible()
    await expect(actions.getByRole('button',{name:'推荐一位老师',exact:true})).toBeVisible()
    await expect(actions.getByRole('button',{name:'邀请已登记老师成为核心成员',exact:true})).toBeVisible()
    expect(new URL(student.url()).hash).toBe('')
    expect(requests.some(url => url.includes('SYNTHETIC_CORE_TOKEN'))).toBe(false)
    const status = await student.evaluate(async () => {
      const s='/src/core/store/index.ts', i='/src/core/teacher-invites.ts'
      const {resumeStore}=await import(s),{coreMemberStatus}=await import(i),session=await resumeStore()
      try { return { role:await session.store.get('settings','role'), status:await coreMemberStatus(session.identity,location.origin) } }
      finally { session.store.close();session.identity.privateKey.fill(0) }
    })
    expect(status).toEqual({role:{role:'student'},status:{teacher:false,core:true}})

    // 核心学生推荐老师，老师登记后接收核心成员晋升。
    if (mode === 'live') {
      await actions.getByLabel('为什么推荐这位老师').fill('合成推荐理由')
      await actions.getByRole('button',{name:'推荐一位老师',exact:true}).click()
      const teacherLink=await actions.getByLabel('邀请链接',{exact:true}).inputValue()
      teacherContext=await browser.newContext()
      const teacher=await teacherContext.newPage()
      await teacher.goto(teacherLink)
      await expect(teacher.getByText('建馆 · 第 1 / 5 步',{exact:true})).toBeVisible()
      await teacher.evaluate(async () => {
        const s='/src/core/store/index.ts', i='/src/core/teacher-invites.ts', h='/src/core/hall/index.ts'
        const {resumeStore}=await import(s),{readTeacherRecommendationLink,registerRecommendedTeacher}=await import(i),{completeHall}=await import(h),session=await resumeStore()
        try {
          await registerRecommendedTeacher(session.identity,location.origin,readTeacherRecommendationLink(location.href))
          await session.store.put('settings','role',{role:'teacher'})
          await completeHall(session.store)
          history.replaceState(null,'',location.pathname+location.search)
        } finally { session.store.close();session.identity.privateKey.fill(0) }
      })
      await teacher.reload()
      await expect(teacher.getByRole('heading',{name:'今天',exact:true})).toBeVisible()
      await teacher.getByRole('button',{name:'我的馆',exact:true}).click()
      await teacher.locator('.hall-row').filter({hasText:'设置'}).click()
      await expect(teacher.getByRole('button',{name:'推荐一位老师',exact:true})).toHaveCount(0)
      await actions.getByRole('button',{name:'邀请已登记老师成为核心成员',exact:true}).click()
      const promotionLink=await actions.getByLabel('邀请链接',{exact:true}).inputValue()
      await teacher.goto(promotionLink)
      await expect(teacher.getByRole('button',{name:'推荐一位老师',exact:true})).toBeVisible()
    }
  } finally {
    releaseCore?.()
    await teacherContext?.close()
    await studentContext?.close()
    await app?.close()
    await gateway?.close()
    await rm(directory,{recursive:true,force:true})
  }
}
try {
  await scenario('live')
  await scenario('cold')
  await scenario('slow')
  await scenario('unselected')
  console.log('PASS: 学生核心成员扫码、推荐老师及晋升；角色保持学生')
} finally { await browser.close() }
