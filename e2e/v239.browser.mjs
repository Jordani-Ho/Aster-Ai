import { chromium, expect } from '@playwright/test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { root } from './process.mjs'
import { startGatewayFixture } from './gateway-fixture.mjs'
import { startWebApp } from './environment.mjs'

// V2-39：学生端把 429 / 401 说清楚。内测实测里手机第一次点“开始使用”只看到
// “暂时未能加入社区”，分不清是限流、手机时间不对还是断网；这里用同一个邀请首屏，
// 把 /invite/redeem 分别挡成 429 和 401，看提示是不是各自的那句。
const cache = path.join(root, '.cache/e2e')
await mkdir(cache, { recursive: true })
const directory = await mkdtemp(path.join(cache, 'v239-'))
let gateway, app, browser
try {
  gateway = await startGatewayFixture({ directory, members: [] })
  app = await startWebApp({ gatewayUrl: gateway.url, relayUrl: 'ws://127.0.0.1:1/' })
  browser = await chromium.launch({ headless: true })

  const teacher = await browser.newPage()
  await teacher.goto(app.url)
  await expect(teacher.getByRole('heading', { name: '您是老师还是学生？' })).toBeVisible()
  const link = await teacher.evaluate(async () => {
    const storePath = '/src/core/store/index.ts', onboardingPath = '/src/core/onboarding/index.ts'
    const { resumeStore } = await import(storePath)
    const { onboardingRequest, makeInvite, inviteLink } = await import(onboardingPath)
    const session = await resumeStore()
    try {
      await onboardingRequest(session.identity, location.origin + '/invite/seed', { token: 'SYNTHETIC_DEPLOYMENT_TOKEN' })
      return inviteLink(location.origin, makeInvite(session.identity, location.origin + '/invite/redeem'))
    } finally { session.store.close(); session.identity.privateKey.fill(0) }
  })

  const student = await browser.newPage()
  await student.route('**/invite/redeem', route => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'too many requests' }) }))
  await student.goto(link)
  await expect(student.getByRole('button', { name: '开始使用', exact: true })).toBeVisible()
  await student.getByRole('button', { name: '开始使用', exact: true }).click()
  await expect(student.getByRole('alert')).toContainText('请求太频繁，请稍等一分钟再点。')

  await student.unroute('**/invite/redeem')
  await student.route('**/invite/redeem', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) }))
  await student.getByRole('button', { name: '开始使用', exact: true }).click()
  await expect(student.getByRole('alert')).toContainText('请检查手机时间是否为自动设置')

  console.log('V2-39 邀请首屏提示：429 / 401 各自说清楚，通过')
} finally {
  await browser?.close().catch(() => {})
  await app?.close().catch(() => {})
  await gateway?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
