import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

// V2-32 浏览器验收：学生在家拍体态 → 问诊包（无图片字节）→ 老师远程核对（老师自己的指标）→ 签字 → 学生记录页。
// 只用合成身份、合成人体图与可注入的骨骼检测器桩；家人账户单独一份身份，老师端按这位家人显示。
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const SHOTS = root + 'docs/screenshots/'
await mkdir(SHOTS, { recursive: true })

// 合成人体图（300×400 PNG）：头 + 躯干 + 四肢，绝无真人照片。
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) } return (crc ^ 0xffffffff) >>> 0 }
function chunk(type, data) { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]) }
function syntheticPng() {
  const width = 300, height = 400, raw = Buffer.alloc((width * 4 + 1) * height)
  const paint = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const at = y * (width * 4 + 1) + 1 + x * 4; raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = 255 }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) paint(x, y, 233, 227, 213)
  const rect = (x0, y0, w, h, color) => { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) paint(x, y, ...color) }
  rect(120, 40, 60, 70, [176, 122, 90])
  rect(110, 115, 80, 130, [74, 107, 90])
  rect(70, 125, 40, 100, [110, 140, 120])
  rect(190, 125, 40, 100, [110, 140, 120])
  rect(115, 245, 30, 120, [60, 80, 70])
  rect(155, 245, 30, 120, [60, 80, 70])
  rect(95, 360, 55, 15, [40, 50, 45])
  rect(150, 360, 55, 15, [40, 50, 45])
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const PNG = syntheticPng()

const server = await createServer({
  configFile: root + 'app/vite.config.ts', root: root + 'app',
  server: { host: '127.0.0.1', port: 0 },
  resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } },
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })

async function open(viewport = { width: 393, height: 852 }) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  const errors = []
  const requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.goto(`${origin}/@fs/${root}e2e/v232.html`)
  await page.waitForFunction(() => Boolean(globalThis.__v232))
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(600)
  return { context, page, errors, requests }
}
const imageInput = 'input[aria-label="拍摄或选择体态照片/视频"]'
async function capture(page, button = '拍正面') {
  await page.getByRole('button', { name: button, exact: true }).click()
  await page.locator(imageInput).setInputFiles({ name: 'synthetic-posture.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByText('识别好了：只留下骨架，照片已经从手机里清掉。', { exact: true })).toBeVisible({ timeout: 20000 })
}
async function send(page) {
  await page.getByRole('button', { name: '发给老师', exact: true }).click()
  await expect(page.getByRole('heading', { name: '已发给老师' })).toBeVisible({ timeout: 15000 })
}
async function openScene(page, scene) {
  await page.evaluate(next => globalThis.__v232.open(next), scene)
  await page.waitForTimeout(500)
}

try {
  const { context, page, errors } = await open()

  // 验收 1：学生端识别出关键点；问诊包里有 postures、没有任何图片字节；应用里查不到照片。
  {
    await expect(page.getByRole('heading', { name: '看一眼，再发出' })).toBeVisible()
    await capture(page, '拍正面')
    await expect(page.locator('svg[aria-label="骨架示意图"]')).toBeVisible()
    const section = page.getByRole('region', { name: '这次的体态' })
    await expect(section).toContainText('只留骨架，照片当场清掉')
    await expect(section).toContainText('正面')

    // 截图：iPhone 15 Pro 与华为两种宽度（合成图、合成骨架）。
    for (const [name, viewport] of [['iphone15pro-393', { width: 393, height: 852 }], ['huawei-412', { width: 412, height: 915 }], ['huawei-448', { width: 448, height: 924 }]]) {
      await page.setViewportSize(viewport)
      await page.waitForTimeout(300)
      await page.screenshot({ path: SHOTS + 'v232-posture-student-' + name + '.png', fullPage: true })
    }
    await page.setViewportSize({ width: 393, height: 852 })
    await page.waitForTimeout(300)

    await send(page)
    const pkg = JSON.parse(await page.evaluate(() => globalThis.__v232.lastPackage()))
    expect(pkg.postures).toHaveLength(1)
    expect(pkg.postures[0].capturedBy).toBe('student')
    expect(pkg.postures[0].metrics).toEqual([])
    expect(pkg.postures[0].values).toEqual({})
    expect(pkg.postures[0].segments).toHaveLength(1)
    expect(pkg.postures[0].segments[0].frame.view).toBe('front')
    expect(pkg.postures[0].segments[0].frame.points.left_shoulder.x).toBeCloseTo(0.4, 3)
    const json = JSON.stringify(pkg)
    expect(json).not.toContain('data:image')
    expect(json).not.toContain('base64')
    expect(json).not.toContain('PNG')
    expect(json).not.toContain('/9j/')
    expect(pkg.attachments).toEqual([])
    const dump = await page.evaluate(() => globalThis.__v232.storeDump('student'))
    expect(dump).not.toContain('data:image')
    expect(dump).not.toContain('base64')
    expect(JSON.parse(dump)['intake-attachments']).toEqual([])
  }

  // 验收 2：老师远程核对页显示骨架图和老师自己加的指标（学生端从未带数值）。
  {
    await openScene(page, 'teacher')
    const review = page.getByRole('region', { name: '学生自己拍的体态' })
    await expect(review).toBeVisible()
    await expect(review.locator('svg[aria-label="骨架示意图"]')).toHaveCount(1)
    await expect(review).toContainText('只有骨架；指标按您的公式算')
    await expect(review).toContainText('两肩高低差：2%')
    await expect(review).toContainText('左右膝高低差：3%')
    const consultJson = await page.evaluate(() => globalThis.__v232.consult())
    expect(consultJson).not.toContain('data:image')
    // 截图：拉高视口，别让固定底栏挡住指标行。
    await page.setViewportSize({ width: 393, height: 1400 })
    await page.waitForTimeout(300)
    await review.screenshot({ path: SHOTS + 'v232-posture-teacher-393.png' })
    await page.setViewportSize({ width: 393, height: 852 })
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: '签字发出', exact: true }).click()
    await expect(page.getByRole('heading', { name: '已签字交还' })).toBeVisible({ timeout: 15000 })
  }

  // 验收 3（记录页）：学生在记录里看到骨架，不显示数值、不下结论。
  {
    await openScene(page, 'records')
    const records = page.getByRole('region', { name: '体态记录' })
    await expect(records).toBeVisible()
    await expect(records.locator('svg[aria-label="骨架示意图"]')).toHaveCount(1)
    await expect(records).toContainText('学生在家拍')
    await expect(records).not.toContainText('两肩高低差')
    await expect(records).not.toContainText('这次算不出')
  }

  // 验收 4：家人账户拍的归在这位家人名下（老师端显示“妈妈”，学生记录页在家人自己这边）。
  {
    await openScene(page, 'family')
    await expect(page.getByRole('heading', { name: '看一眼，再发出' })).toBeVisible()
    await expect(page.getByText('妈妈', { exact: false }).first()).toBeVisible()
    await capture(page, '拍侧面')
    await send(page)
    const pkg = JSON.parse(await page.evaluate(() => globalThis.__v232.lastPackage()))
    const identities = await page.evaluate(() => globalThis.__v232.identities)
    expect(pkg.encounter.student).toBe(identities.member)
    expect(pkg.manager).toBe(identities.manager)
    expect(pkg.postures[0].segments[0].frame.view).toBe('side')

    await openScene(page, 'teacher')
    const review = page.getByRole('region', { name: '学生自己拍的体态' })
    await expect(review).toBeVisible()
    await expect(review).toContainText('妈妈')
    await expect(review.locator('svg[aria-label="骨架示意图"]')).toHaveCount(1)
    await expect(review).toContainText('两肩高低差：2%')
    await page.getByRole('button', { name: '签字发出', exact: true }).click()
    await expect(page.getByRole('heading', { name: '已签字交还' })).toBeVisible({ timeout: 15000 })

    await openScene(page, 'family-records')
    const records = page.getByRole('region', { name: '体态记录' })
    await expect(records).toBeVisible()
    await expect(records).toContainText('学生在家拍')
    await expect(records.locator('svg[aria-label="骨架示意图"]')).toHaveCount(1)
  }

  // 验收 3（可选项）：不拍体态也能正常发出问诊；老师核对页没有体态块。
  {
    await openScene(page, 'optional')
    await expect(page.getByRole('heading', { name: '看一眼，再发出' })).toBeVisible()
    await expect(page.getByRole('region', { name: '这次的体态' })).toBeVisible()
    await send(page)
    const pkg = JSON.parse(await page.evaluate(() => globalThis.__v232.lastPackage()))
    expect(pkg.postures).toBeUndefined()
    await openScene(page, 'teacher')
    await expect(page.getByRole('region', { name: '学生自己拍的体态' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '签字发出', exact: true })).toBeVisible()
  }

  expect(errors).toEqual([])
  await context.close()

  // 验收 5：截图落盘（iPhone 15 Pro / 华为两种宽度）。
  const { stat } = await import('node:fs/promises')
  for (const name of ['v232-posture-student-iphone15pro-393.png', 'v232-posture-student-huawei-412.png', 'v232-posture-student-huawei-448.png', 'v232-posture-teacher-393.png']) {
    expect((await stat(SHOTS + name)).size).toBeGreaterThan(1000)
  }

  console.log('PASS: V2-32 学生在家拍体态 — 学生端识别并清照片、问诊包只有关键点、老师按自己的指标算、签字后学生记录页只显示骨架、家人归位、可拍可不拍、三张宽度截图')
} finally {
  await browser.close()
  await server.close()
}
