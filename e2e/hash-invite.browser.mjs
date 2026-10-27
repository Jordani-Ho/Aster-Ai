import { chromium, expect } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { root } from './process.mjs'
import { startGatewayFixture } from './gateway-fixture.mjs'
import { startWebApp } from './environment.mjs'

const cache = path.join(root, '.cache/e2e')
await mkdir(cache, { recursive: true })
const directory = await mkdtemp(path.join(cache, 'hash-invite-'))
let gateway, app, browser
try {
  gateway = await startGatewayFixture({ directory, members: [] })
  app = await startWebApp({ gatewayUrl: gateway.url, relayUrl: 'ws://127.0.0.1:1/' })
  browser = await chromium.launch({ headless: true })
  const founder = await browser.newPage()
  await founder.goto(app.url)
  await expect(founder.getByRole('heading', { name: '您是老师还是学生？' })).toBeVisible()
  const links = await founder.evaluate(async () => {
    const storePath='/src/core/store/index.ts', onboardingPath='/src/core/onboarding/index.ts', invitePath='/src/core/teacher-invites.ts'
    const {resumeStore}=await import(storePath), {onboardingRequest}=await import(onboardingPath)
    const {makeTeacherRecommendation,teacherRecommendationLink,makeCorePromotion,corePromotionLink}=await import(invitePath)
    const session=await resumeStore()
    try {
      await onboardingRequest(session.identity,location.origin+'/invite/core-seed',{token:'SYNTHETIC_CORE_TOKEN'})
      return {
        teacher:teacherRecommendationLink(location.origin,makeTeacherRecommendation(session.identity,location.origin+'/invite/teacher','合成推荐理由')),
        promotion:corePromotionLink(location.origin,makeCorePromotion(session.identity,location.origin+'/invite/core-add')),
      }
    } finally { session.store.close();session.identity.privateKey.fill(0) }
  })

  const teacher = await browser.newPage()
  await teacher.goto(app.url)
  await expect(teacher.getByRole('heading',{name:'您是老师还是学生？'})).toBeVisible()
  await teacher.goto(links.teacher)
  await expect(teacher.getByText('建馆 · 第 1 / 5 步',{exact:true})).toBeVisible()
  // 准备已登记老师；随后晋升仅改变 fragment。
  const studentLink = await teacher.evaluate(async () => {
    const storePath='/src/core/store/index.ts', invitePath='/src/core/teacher-invites.ts', hallPath='/src/core/hall/index.ts', onboardingPath='/src/core/onboarding/index.ts'
    const {resumeStore}=await import(storePath),{readTeacherRecommendationLink,registerRecommendedTeacher}=await import(invitePath),{completeHall}=await import(hallPath),{makeInvite,inviteLink}=await import(onboardingPath)
    const session=await resumeStore()
    try {
      await registerRecommendedTeacher(session.identity,location.origin,readTeacherRecommendationLink(location.href))
      await session.store.put('settings','role',{role:'teacher'})
      await completeHall(session.store)
      history.replaceState(null,'',location.pathname+location.search)
      return inviteLink(location.origin,makeInvite(session.identity,location.origin+'/invite/redeem'))
    } finally { session.store.close();session.identity.privateKey.fill(0) }
  })
  await teacher.reload()
  await expect(teacher.getByRole('heading',{name:'今天',exact:true})).toBeVisible()
  await teacher.getByRole('button',{name:'我的馆',exact:true}).click()
  await teacher.locator('.hall-row').filter({hasText:'设置'}).click()
  await expect(teacher.getByRole('button',{name:'推荐一位老师',exact:true})).toHaveCount(0)
  await teacher.goto(links.promotion)
  await expect(teacher.getByRole('button',{name:'推荐一位老师',exact:true})).toBeVisible()
  await expect(teacher.getByText('已成为核心成员，现在可以推荐老师。',{exact:true})).toBeVisible()

  const student = await browser.newPage()
  await student.goto(app.url)
  await expect(student.getByRole('heading',{name:'您是老师还是学生？'})).toBeVisible()
  await student.evaluate(()=>{location.hash='#teacher-invite=broken'})
  await expect(student.getByRole('alert')).toContainText('老师推荐链接已失效')
  await student.goto(studentLink)
  await expect(student.getByRole('button',{name:'开始使用',exact:true})).toBeVisible()
  await student.getByRole('button',{name:'开始使用',exact:true}).click()
  await expect(student.getByRole('heading',{name:'接入您的大模型',exact:true})).toBeVisible()
  const repeat = student.waitForResponse(response=>response.url().endsWith('/invite/redeem'))
  await student.goto(studentLink)
  expect((await repeat).status()).toBe(200)
  await expect.poll(() => new URL(student.url()).hash).toBe('')
  await expect(student.getByRole('button',{name:'开始使用',exact:true})).toHaveCount(0)
  await student.evaluate(()=>{location.hash='#teacher-invite=broken'})
  await expect(student.getByRole('alert')).toContainText('老师推荐链接已失效')

  const basics = await browser.newPage()
  await basics.goto(app.url + '/@fs/' + root.replaceAll('\\','/') + 'e2e/basics-loading.html')
  const alias=basics.getByLabel('称呼',{exact:true})
  await expect(basics.getByRole('button',{name:'重新读取',exact:true})).toBeVisible()
  await expect(alias).toBeDisabled()
  await basics.getByRole('button',{name:'重新读取',exact:true}).click()
  await expect(alias).toHaveValue('合成一')
  await expect(alias).toBeEnabled()
  await basics.getByRole('button',{name:'切换资料',exact:true}).click()
  await expect(alias).toBeDisabled()
  await basics.getByRole('button',{name:'完成读取',exact:true}).click()
  await expect(alias).toHaveValue('合成二')
  await expect(alias).toBeEnabled()
  console.log('hash invitation and basics loading browser checks passed')
} finally {
  await browser?.close()
  await app?.close()
  await gateway?.close()
  await rm(directory,{recursive:true,force:true})
}
