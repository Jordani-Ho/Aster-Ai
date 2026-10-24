import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

// V2-30 体态工具浏览器验收：真实组件 + 可注入的骨骼检测器桩（scene=real 时用真实模型资产做本地加载 smoke）。
// 只用合成图；照片/视频识别后不入库。
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const SHOTS = root + 'docs/screenshots/'
await mkdir(SHOTS, { recursive: true })

// 生成一张合成人体图（300×400 PNG）：头 + 躯干 + 四肢，绝无真人照片。
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) } return (crc ^ 0xffffffff) >>> 0 }
function chunk(type, data) { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]) }
function syntheticPng() {
  const width = 300, height = 400, raw = Buffer.alloc((width * 4 + 1) * height)
  const paint = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= width || y >= height) return; const at = y * (width * 4 + 1) + 1 + x * 4; raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = 255 }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) paint(x, y, 233, 227, 213)
  const rect = (x0, y0, w, h, color) => { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) paint(x, y, ...color) }
  rect(120, 40, 60, 70, [176, 122, 90]) // 头
  rect(110, 115, 80, 130, [74, 107, 90]) // 躯干
  rect(70, 125, 40, 100, [110, 140, 120]) // 左臂
  rect(190, 125, 40, 100, [110, 140, 120]) // 右臂
  rect(115, 245, 30, 120, [60, 80, 70]) // 左腿
  rect(155, 245, 30, 120, [60, 80, 70]) // 右腿
  rect(95, 360, 55, 15, [40, 50, 45]) // 左脚
  rect(150, 360, 55, 15, [40, 50, 45]) // 右脚
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

async function open(scene, viewport = { width: 393, height: 852 }) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  const errors = []
  const requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.goto(`${origin}/@fs/${root}e2e/posture.html?scene=${scene}`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(600)
  return { context, page, errors, requests }
}
const imageInput = 'input[aria-label="拍摄或选择体态照片/视频"]'
async function capture(page) { await page.locator(imageInput).setInputFiles({ name: 'synthetic-posture.png', mimeType: 'image/png', buffer: PNG }); await expect(page.getByText('识别完成：照片/视频已从应用内清掉，只留关键点。', { exact: true })).toBeVisible({ timeout: 20000 }) }
function fakePoints(page, patch) { return page.evaluate(value => Object.assign(globalThis.__posture.points, value), patch) }

try {
  // 验收 1：合成正面/侧面 → 关键点、四条示例指标有值；照片查不到
  {
    const { context, page, errors } = await open('tool')
    await capture(page)
    const table = page.getByRole('table', { name: '这一段指标' })
    await expect(table.locator('tbody tr')).toHaveCount(4)
    await expect(table).toContainText('两肩高低差')
    expect(await table.innerText()).not.toContain('这次算不出')
    await page.getByRole('button', { name: '侧面', exact: true }).click()
    await fakePoints(page, { right_shoulder: { x: 0.62, y: 0.34, visibility: 0.9 } })
    await capture(page)
    await expect(page.getByText('2 段 · 点关节可标失衡 / 拖动可改点', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '保存这段体态记录', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('体态记录已保存到本机')
    const dump = await page.evaluate(() => globalThis.__posture.draftBytes())
    expect(dump).not.toContain('data:image'); expect(dump).not.toContain('base64'); expect(dump).toContain('segments')
    expect(errors).toEqual([])
    await context.close()
  }

  // 验收 2：老师新加“左右膝高低差”，下次记录自动算出
  {
    const { context, page, errors } = await open('metrics')
    await page.getByRole('button', { name: '加一条指标', exact: true }).click()
    const rows = page.locator('div[aria-label="体态指标"] ul.nl-list > li')
    const last = rows.last()
    await last.getByLabel('名称').fill('左右膝高低差')
    await last.getByLabel('公式').fill('heightDiff(left_knee, right_knee)')
    await last.getByLabel('单位').fill('%')
    await page.getByRole('button', { name: '保存体态指标', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('体态指标已保存')
    // 同一位老师（同一本机 store）下一次记录：新指标自动算出
    await page.goto(`${origin}/@fs/${root}e2e/posture.html?scene=tool`)
    await page.waitForLoadState('networkidle'); await page.waitForTimeout(600)
    await capture(page)
    const table = page.getByRole('table', { name: '这一段指标' })
    await expect(table).toContainText('左右膝高低差')
    await expect(table.locator('tbody tr')).toHaveCount(5)
    expect(errors).toEqual([])
    await context.close()
  }

  // 验收 3：合成 FreeMoCap 导出文件导入后，与手机同一套指标、同一张骨架图
  {
    const { context, page, errors } = await open('tool')
    await capture(page)
    const csv = ['frame,keypoint,x,y,z,model', ...['nose', 'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'].map((name, index) => `0,${name},${(index % 5) * 40 - 80},0,${1600 - index * 150},mediapipe.body`)].join('\n')
    await page.locator('input[aria-label="导入 FreeMoCap 导出文件"]').setInputFiles({ name: 'freemocap_data_by_frame.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await expect(page.getByText('识别完成：照片/视频已从应用内清掉，只留关键点。', { exact: true })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('table', { name: '这一段指标' }).locator('tbody tr')).toHaveCount(4)
    await expect(page.locator('svg[aria-label="骨架示意图（可拖点）"]')).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }

  // 验收 4：同一学生两次记录 → 每条指标前后对比
  {
    const { context, page, errors } = await open('tool')
    await page.evaluate(() => globalThis.__posture.seed(2))
    await page.reload(); await page.waitForLoadState('networkidle'); await page.waitForTimeout(600)
    await page.getByRole('button', { name: '记录对比', exact: true }).click()
    const compare = page.getByRole('table', { name: '和上次比' })
    await expect(compare).toBeVisible()
    await expect(compare.locator('tbody tr')).toHaveCount(4)

    // 4b：弯腰·前 / 弯腰·后 两段并排、指标变化正确
    await page.getByRole('button', { name: '采集', exact: true }).click()
    await page.getByLabel('动作', { exact: true }).selectOption('弯腰')
    await page.getByLabel('阶段', { exact: true }).selectOption('before')
    await capture(page)
    await fakePoints(page, { left_shoulder: { x: 0.4, y: 0.34, visibility: 0.9 }, right_shoulder: { x: 0.6, y: 0.34, visibility: 0.9 } })
    await page.getByLabel('阶段', { exact: true }).selectOption('after')
    await capture(page)
    await page.getByRole('button', { name: '保存这段体态记录', exact: true }).click()
    await page.getByRole('button', { name: '记录对比', exact: true }).click()
    await expect(page.getByRole('region', { name: '做动作前后对比' })).toContainText('弯腰：做动作前 / 后')
    await expect(page.getByRole('table', { name: '前后指标变化' })).toContainText('两肩高低差')
    await expect(page.locator('svg[aria-label="骨架示意图"]')).toHaveCount(2)
    expect(errors).toEqual([])
    await context.close()
  }

  // 4c：拖动肩点 → 标“老师改过”、重算；签字后再打开，标注/辅助线/改动都在
  {
    const { context, page, errors } = await open('tool')
    await capture(page)
    // 拖动右肩到 y=0.40（两肩高低差 2% → 10%）
    await page.evaluate(() => {
      const circle = [...document.querySelectorAll('svg circle')].find(node => node.querySelector('title')?.textContent?.startsWith('right_shoulder'))
      const rect = circle.ownerSVGElement.getBoundingClientRect()
      const options = { bubbles: true, clientX: rect.left + rect.width * 0.6, clientY: rect.top + rect.height * 0.4, pointerId: 1, pointerType: 'mouse' }
      circle.dispatchEvent(new PointerEvent('pointerdown', options))
      circle.dispatchEvent(new PointerEvent('pointermove', options))
      circle.dispatchEvent(new PointerEvent('pointerup', options))
    })
    await expect(page.getByRole('table', { name: '这一段指标' })).toContainText('10')
    await page.evaluate(() => {
      const circle = [...document.querySelectorAll('svg circle')].find(node => node.querySelector('title')?.textContent?.startsWith('right_shoulder'))
      circle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.getByLabel('失衡原因').fill('左肩高')
    await page.getByRole('button', { name: '标失衡', exact: true }).click()
    await page.getByRole('button', { name: '画两肩连线', exact: true }).click()
    await expect(page.getByText('老师改过：', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '保存这段体态记录', exact: true }).click()
    await page.evaluate(() => globalThis.__posture.signAll())
    await page.evaluate(() => globalThis.__postureUi.openSigned())
    await expect(page.getByRole('region', { name: '这次面诊的体态记录' })).toContainText('10%')
    await expect(page.getByRole('region', { name: '这次面诊的体态记录' })).toContainText('失衡：right_shoulder（左肩高）')
    await expect(page.locator('svg[aria-label="骨架示意图"] circle title').filter({ hasText: '老师改过' })).toHaveCount(1)
    await expect(page.locator('svg[aria-label="骨架示意图"] line[stroke-dasharray]').first()).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }

  // 4d：三个月六次记录 → 每条指标走势；标过三次失衡的节点显示 3 次
  {
    const { context, page, errors } = await open('tool')
    await page.evaluate(() => globalThis.__posture.seed(6, 3))
    await page.reload(); await page.waitForLoadState('networkidle'); await page.waitForTimeout(600)
    await page.getByRole('button', { name: '趋势', exact: true }).click()
    const trends = page.getByRole('region', { name: '体态长期趋势' })
    await expect(trends).toContainText('两肩高低差')
    await expect(trends).toContainText('3 次')
    const lines = await trends.locator('div.nl-homework-item p').allTextContents()
    expect(lines.join('')).toContain('2 → 2 → 2 → 2 → 2 → 2')
    expect(errors).toEqual([])
    await context.close()
  }

  // 验收 5：真实模型资产只从本部署加载，不请求国外域名
  {
    const { context, page, errors, requests } = await open('real')
    await page.locator(imageInput).setInputFiles({ name: 'synthetic-posture.png', mimeType: 'image/png', buffer: PNG })
    // CI 机器慢的时候模型/wasm 可能加载更久；等到两样都请求过再断言（最多 90 秒）。
    await expect.poll(() => requests.filter(url => url.includes('/posture/pose_landmarker_lite.task')).length, { timeout: 90000 }).toBeGreaterThan(0)
    await expect.poll(() => requests.filter(url => url.includes('/posture/wasm/')).length, { timeout: 90000 }).toBeGreaterThan(0)
    await page.waitForTimeout(1500)
    const external = requests.filter(url => !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:'))
    const assetRequests = requests.filter(url => url.startsWith(origin) && url.includes('/posture/'))
    expect(assetRequests.some(url => url.includes('pose_landmarker_lite.task'))).toBe(true)
    expect(assetRequests.some(url => url.includes('/posture/wasm/'))).toBe(true)
    expect(external).toEqual([])
    console.log('real smoke: asset requests', assetRequests.map(url => url.replace(origin, '')).join(', '), 'page errors', errors.length)
    await context.close()
  }

  // 验收 6：iPhone 15 Pro 与华为两种宽度截图
  {
    for (const [name, viewport] of [['iphone15pro-393', { width: 393, height: 852 }], ['huawei-412', { width: 412, height: 915 }], ['huawei-448', { width: 448, height: 924 }]]) {
      const { context, page } = await open('tool', viewport)
      await capture(page)
      await page.screenshot({ path: SHOTS + 'posture-' + name + '.png' })
      await context.close()
    }
  }

  console.log('PASS: V2-30 体态工具 — 采集/导入同一套指标、照片不入库、指标可加、两次对比、前后两段、拖点标注并随签字保存、六个月趋势与失衡次数、真实模型资产只从本站加载、两机型截图')
} finally {
  await browser.close()
  await server.close()
}
