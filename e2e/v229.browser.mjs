import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

// V2-29 验收（合成数据、模型替身）：
// 1) 还剩多问时点“跳过，直接整理”：直接到卡片页、模型不再被调用、没问到的项显示“未提供”
// 2) 回答一问后点“补充好了，整理卡片”：还有要问就继续问，没有就到卡片页
// 3) 学生端“我 → 设置”与老师端“我的馆 → 设置”底部版本号 = 构建时 git rev-parse --short HEAD
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const SHOTS = root + 'docs/screenshots/'
await mkdir(SHOTS, { recursive: true })
const gitHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

const server = await createServer({
  configFile: root + 'app/vite.config.ts', root: root + 'app',
  server: { host: '127.0.0.1', port: 0 },
  resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } },
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })
let envServer = null

async function open(scene) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/chat/completions', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '合成模型回答' } }] }) }))
  await page.route('https://phone.synthetic.invalid/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('https://geocoding-api.open-meteo.com/**', route => route.fulfill({ status: 200, body: '{}' }))
  await page.route('https://api.open-meteo.com/**', route => route.fulfill({ status: 200, body: '{}' }))
  await page.goto(`${origin}/@fs/${root}e2e/phone.html?scene=${scene}`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1200)
  return { context, page, errors }
}
const modelCalls = page => page.evaluate(() => window.__phone.intake.modelCalls)
async function startConsult(page) {
  await page.getByRole('button', { name: /不舒服？告诉/ }).click()
  await page.getByLabel('按键盘上的🎤说话就行', { exact: true }).fill('最近睡不好，夜里容易醒')
  await page.getByRole('button', { name: '说好了，继续', exact: true }).click()
  await expect(page.getByRole('heading', { name: '再问一句', exact: true })).toBeVisible({ timeout: 15000 })
}
const TWO_QUESTIONS = [
  { focus: '二问汗', text: '夜里出汗吗？' },
  { focus: '三问头身', text: '头、身上有没有不舒服？' },
]

try {
  // 1) 跳过 = 一次结束追问，直接进卡片；模型不再被调用；没问到的项保持“未提供”
  {
    const { context, page, errors } = await open('consult')
    await page.evaluate(() => { window.__phone.intake.replies = [] })
    await page.evaluate(() => { window.__phone.intake.replies.push([{ focus: '二问汗', text: '夜里出汗吗？' }, { focus: '三问头身', text: '头、身上有没有不舒服？' }]) })
    await startConsult(page)
    const before = await modelCalls(page)
    await page.getByRole('button', { name: '跳过，直接整理', exact: true }).click()
    await expect(page.getByRole('heading', { name: '看一眼，再发出', exact: true })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('heading', { name: '再问一句', exact: true })).toHaveCount(0)
    expect(await modelCalls(page)).toBe(before)
    const card = page.getByRole('region', { name: '问诊卡片' })
    await expect(card).toBeVisible()
    const cardText = await card.innerText()
    // 主诉来自之前那句话；没问到/没答的现病史显示“未提供”；
    // 既往史、在用药与过敏由进馆基础信息自动带入（V2-23），不编造。
    expect(cardText).toContain('最近睡不好')
    expect((cardText.match(/未提供/g) ?? []).length).toBeGreaterThanOrEqual(1)
    expect(cardText).toContain('在用药：无；过敏：无')
    expect(cardText).not.toContain('夜里出汗吗')
    expect(await page.getByRole('button', { name: '跳过，直接整理', exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
    await context.close()
  }

  // 2) 回答一问 → 还有要问就继续问；继续答到模型/轮次不再问 → 到卡片页（与现在一致）
  {
    const { context, page, errors } = await open('consult')
    await page.evaluate(() => { window.__phone.intake.replies = [[{ focus: '二问汗', text: '夜里出汗吗？' }]] })
    await startConsult(page)
    await page.getByLabel('补充一下', { exact: true }).fill('夜里容易出汗')
    await page.getByRole('button', { name: '补充好了，整理卡片', exact: true }).click()
    // 回答一问后仍在追问（这里下一问由固定问句补上）。
    await expect(page.getByRole('heading', { name: '再问一句', exact: true })).toBeVisible({ timeout: 15000 })
    for (let guard = 0; guard < 6; guard += 1) {
      if (await page.getByRole('heading', { name: '看一眼，再发出', exact: true }).count()) break
      await page.getByLabel('补充一下', { exact: true }).fill('补充一句' + guard)
      await page.getByRole('button', { name: '补充好了，整理卡片', exact: true }).click()
      await page.waitForTimeout(400)
    }
    await expect(page.getByRole('heading', { name: '看一眼，再发出', exact: true })).toBeVisible({ timeout: 15000 })
    // V2-26：追问的回答单独成对保存在“本次原话与问答”里，不混进问诊卡片的现病史。
    const cardText = await page.getByRole('region', { name: '问诊卡片' }).innerText()
    expect(cardText).not.toContain('夜里容易出汗')
    const originals = page.getByRole('group', { name: '本次原话和追问回答' })
    await originals.locator('summary').click()
    expect(await originals.innerText()).toContain('夜里容易出汗')
    expect(errors).toEqual([])
    await context.close()
  }

  // 3) 两端设置页底部版本号 = 构建时 git rev-parse --short HEAD（Vite define 注入）
  const versionPattern = new RegExp('^版本 ' + gitHead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' · \\d{2}-\\d{2}$')
  const versions = {}
  {
    const { context, page, errors } = await open('me')
    await page.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '我', exact: true }).click()
    await page.getByRole('button', { name: /^设置/ }).click()
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
    const version = page.locator('[data-testid=app-version]')
    await version.scrollIntoViewIfNeeded()
    await expect(version).toBeVisible()
    versions.student = (await version.innerText()).trim()
    expect(versions.student).toMatch(versionPattern)
    await page.screenshot({ path: SHOTS + 'v229-version-student-375.png' })
    expect(errors).toEqual([])
    await context.close()
  }
  {
    const { context, page, errors } = await open('hall')
    await page.getByRole('button', { name: '我的馆', exact: true }).click()
    await page.locator('.hall-row').filter({ hasText: '设置' }).click()
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
    const version = page.locator('[data-testid=app-version]')
    await version.scrollIntoViewIfNeeded()
    await expect(version).toBeVisible()
    versions.teacher = (await version.innerText()).trim()
    expect(versions.teacher).toMatch(versionPattern)
    await page.screenshot({ path: SHOTS + 'v229-version-teacher-375.png' })
    expect(errors).toEqual([])
    await context.close()
  }
  // 两端同一来源：文字完全一致。
  expect(versions.student).toBe(versions.teacher)

  // 4) 部署链路：镜像里没有 .git，版本号靠宿主机经环境变量传进来。
  //    这里模拟 setup.sh 算好 APP_VERSION/APP_BUILD_DATE 后容器启动构建，页面应显示这两个值。
  process.env.APP_VERSION = 'deadbee'
  process.env.APP_BUILD_DATE = '01-02'
  envServer = await createServer({
    configFile: root + 'app/vite.config.ts', root: root + 'app',
    server: { host: '127.0.0.1', port: 0 },
    resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } },
  })
  await envServer.listen()
  const envOrigin = `http://127.0.0.1:${envServer.httpServer.address().port}`
  {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
    const page = await context.newPage()
    await page.goto(`${envOrigin}/@fs/${root}e2e/phone.html?scene=version`)
    const version = page.locator('[data-testid=app-version]')
    await expect(version).toBeVisible({ timeout: 15000 })
    const injected = (await version.innerText()).trim()
    expect(injected).toBe('版本 deadbee · 01-02')
    versions.hostInjected = injected
    await context.close()
  }

  console.log(JSON.stringify({ gitHead, versions, questions: TWO_QUESTIONS.length }))
  console.log('PASS: V2-29 跳过直接整理（不再追问、不再调模型、未问项未提供）、逐问流程保持、两端版本号 = ' + gitHead + '、宿主机传值 = ' + versions.hostInjected)
} finally {
  await browser.close()
  await server.close()
  if (envServer) await envServer.close()
}
