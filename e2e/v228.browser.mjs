import { chromium, expect, webkit } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'

// V2-28 建馆傻瓜化浏览器验收（合成数据，不调真实模型）：
// 1) 口令粘贴带空格 → 登记请求里的口令是干净的；页面写清口令在哪、为什么、用过作废
// 2) 选 Kimi 自动填接口地址与模型名；密钥错时提示“密钥不对”
// 3) 部署开了社区网关模型 → 学生不填自己的 Key 也能进首页；没开时给出明确提示
// 4) 无痕窗口（短窗口）与 iPhone 15 Pro / 华为两种宽度：底部按钮可见可点（截图）
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const SHOTS = root + 'docs/screenshots/'
await mkdir(SHOTS, { recursive: true })

const server = await createServer({
  configFile: root + 'app/vite.config.ts', root: root + 'app',
  server: { host: '127.0.0.1', port: 0 },
  resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } },
  define: {
    'import.meta.env.VITE_MODEL_GATEWAY_URL': JSON.stringify('https://app.synthetic.invalid/v1'),
    'import.meta.env.VITE_COMMUNITY_MODEL': JSON.stringify('1'),
  },
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = { chromium: await chromium.launch({ headless: true }), webkit: await webkit.launch({ headless: true }) }

const HUAWEI_UA = 'Mozilla/5.0 (Linux; Android 10; NOH-AN00 Build/HUAWEINOH-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/99.0.4844.88 HuaweiBrowser/13.0.1.300 Mobile Safari/537.36'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const DEVICES = [
  { name: 'iphone15pro-393', engine: 'webkit', options: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA }, shot: 'v228-bottom-iphone15pro.png' },
  { name: 'huawei-412', engine: 'chromium', options: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: HUAWEI_UA } },
  { name: 'huawei-448', engine: 'chromium', options: { viewport: { width: 448, height: 924 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: HUAWEI_UA }, shot: 'v228-bottom-huawei-448.png' },
  { name: 'incognito-780x500', engine: 'chromium', options: { viewport: { width: 780, height: 500 } }, shot: 'v228-bottom-incognito.png' },
]

const chatReply = (text = '合成模型回答') => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: text } }] }) })
async function pageFor(device, routes = {}) {
  const context = await browser[device.engine].newContext(device.options)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // Playwright 里后注册的路由优先；先注册通用模型路由，再注册各场景专用路由。
  await page.route('**/chat/completions', route => routes.chat ? routes.chat(route) : route.fulfill(chatReply()))
  await page.route('https://opening.synthetic.invalid/**', route => routes.seed ? routes.seed(route) : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('https://app.synthetic.invalid/**', route => routes.community ? routes.community(route) : route.fulfill(chatReply()))
  await page.route('https://geocoding-api.open-meteo.com/**', route => route.fulfill({ status: 200, body: '{}' }))
  await page.route('https://api.open-meteo.com/**', route => route.fulfill({ status: 200, body: '{}' }))
  return { context, page, errors }
}
const report = {}

// 1) 建馆第 1 步：Kimi 自动填地址与模型名；密钥错 → “密钥不对”
{
  const { context, page, errors } = await pageFor(DEVICES[1], { chat: route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"synthetic"}' }) })
  await page.goto(`${origin}/@fs/${root}e2e/opening.html?scene=guide&name=v228-kimi`)
  await expect(page.getByRole('button', { name: 'Kimi', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Kimi', exact: true }).click()
  await expect(page.getByText('https://api.moonshot.cn/v1', { exact: false })).toBeVisible()
  await expect(page.getByText('kimi-k3', { exact: false })).toBeVisible()
  await page.getByLabel('模型账户密钥', { exact: true }).fill('SYNTHETIC_BAD_KEY')
  await page.getByRole('button', { name: '测试并继续', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('密钥不对')
  expect(errors).toEqual([])
  report.kimi = { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3', wrongKey: '密钥不对' }
  await context.close()
}

// 2) 口令：粘贴带前后空格 → 登记成功，请求里的 token 已去掉空白；说明写明在哪/为什么/用过作废
{
  const seeds = []
  const { context, page, errors } = await pageFor(DEVICES[1], { seed: route => { if (route.request().url().endsWith('/invite/seed')) seeds.push(JSON.parse(route.request().postData() ?? '{}')); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) } })
  await page.goto(`${origin}/@fs/${root}e2e/opening.html?scene=guide&name=v228-token`)
  await page.getByLabel('模型账户密钥', { exact: true }).fill('SYNTHETIC_KEY')
  await page.getByRole('button', { name: '测试并继续', exact: true }).click()
  await expect(page.getByLabel('登记口令', { exact: true })).toBeVisible()
  const notes = (await page.locator('.op-card-note').allTextContents()).join('\n')
  expect(notes).toContain('data/setup/teacher-setup-code.txt')
  expect(notes).toContain('用过就作废')
  await page.getByLabel('学生怎么称呼您', { exact: true }).fill('合成阿慈')
  await page.getByLabel('登记口令', { exact: true }).fill('  SYNTHETIC_DEPLOYMENT_TOKEN  ')
  await page.getByRole('button', { name: '登记，下一步', exact: true }).click()
  await expect(page.getByRole('heading', { name: '给您的馆起个名', exact: true })).toBeVisible()
  expect(seeds.at(-1)?.token).toBe('SYNTHETIC_DEPLOYMENT_TOKEN')
  expect(errors).toEqual([])
  report.token = { pasted: '  SYNTHETIC_DEPLOYMENT_TOKEN  ', sent: seeds.at(-1)?.token, notes: '口令在哪/为什么/用过作废' }
  await context.close()
}

// 3) + 4) 底部按钮：欢迎首屏与“先用社区模型”页，在无痕短窗口 / iPhone 15 Pro / 华为宽度都要看得到、点得到
for (const device of DEVICES) {
  const { context, page, errors } = await pageFor(device)
  const deviceReport = { viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })).catch(() => null) }

  // 欢迎首屏的“开始使用”
  await page.goto(`${origin}/@fs/${root}e2e/phone.html?scene=welcome`)
  const start = page.getByRole('button', { name: '开始使用', exact: true })
  await expect(start).toBeVisible()
  await expect(start).toBeInViewport()
  await start.click()
  deviceReport.welcomeStart = await start.evaluate(node => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.top >= 0 && r.bottom <= innerHeight } })
  expect(deviceReport.welcomeStart.visible).toBe(true)
  if (device.shot) await page.screenshot({ path: SHOTS + device.shot })

  // 接入模型页的“先用社区模型开始”（整页 App，从学生入口进入）
  await page.goto(`${origin}/@fs/${root}e2e/app.html`)
  const community = page.getByRole('button', { name: '先用社区模型开始', exact: true })
  await expect(community).toBeVisible({ timeout: 30000 })
  await expect(community).toBeInViewport()
  deviceReport.communityStart = await community.evaluate(node => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.top >= 0 && r.bottom <= innerHeight } })
  expect(deviceReport.communityStart.visible).toBe(true)
  if (device.shot) await page.screenshot({ path: SHOTS + device.shot.replace('bottom', 'community-setup') })
  await community.click()
  await expect(page.locator('[data-page=student-today]')).toBeVisible({ timeout: 30000 })
  const saved = await page.evaluate(() => window.__v228())
  expect(saved.community?.mode).toBe('gateway')
  expect(saved.personal).toBeUndefined()
  deviceReport.community = { mode: saved.community?.mode, personal: saved.personal ?? null, home: 'student-today' }
  if (device.name.startsWith('huawei-448')) await page.screenshot({ path: SHOTS + 'v228-community-huawei.png' })
  if (device.name.startsWith('iphone')) await page.screenshot({ path: SHOTS + 'v228-community-iphone.png' })
  expect(errors).toEqual([])
  report[device.name] = deviceReport
  await context.close()
}

// 4b) 部署没开社区模型（网关 503）：先试一句就告诉学生，不要卡在原地
{
  const { context, page, errors } = await pageFor(DEVICES[0], { community: route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) })
  await page.goto(`${origin}/@fs/${root}e2e/app.html`)
  const community = page.getByRole('button', { name: '先用社区模型开始', exact: true })
  await expect(community).toBeVisible({ timeout: 30000 })
  await community.click()
  await expect(page.getByRole('alert')).toContainText('没有开社区模型')
  await expect(page.locator('[data-page=student-today]')).toHaveCount(0)
  report.communityDenied = { alert: await page.getByRole('alert').innerText() }
  expect(errors).toEqual([])
  await context.close()
}

for (const engine of Object.values(browser)) await engine.close()
await server.close()
console.log(JSON.stringify(report, null, 2))
console.log('PASS: V2-28 口令去空白、Kimi 自动填+密钥错提示、社区模型免 Key 进首页、无痕/iPhone/华为底部按钮可见；截图已写入 docs/screenshots/')
