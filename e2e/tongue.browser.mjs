import { chromium, expect, webkit } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
import { readFile, mkdir, writeFile } from 'node:fs/promises'

// V2-20 舌象修复验收（合成图，无真人照片）：
// 华为（Chromium + 华为浏览器 UA）与 iPhone 15 Pro（WebKit，393×852 DPR3）两种内核，
// 覆盖镜子完整显示、送模型前规范化（MIME/大图）、模型回复容错、短边门槛、失败分档与自动重试、HEIC 行为。
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const IMAGES = root + 'e2e/fixtures/tongue/'
const SHOTS = root + 'docs/screenshots/'
await mkdir(SHOTS, { recursive: true })
const meta = JSON.parse(await readFile(IMAGES + 'metadata.json', 'utf8'))
const image = name => readFile(IMAGES + name)
const features = (box, patch = {}) => JSON.stringify({ color: 'pale', coatingColor: 'white', coatingThickness: 'thin', shape: 'wide', teeth: [], cracks: [], confidence: 0.7, box, lightingNote: false, ...patch })
const CENTRAL = meta['tongue-normal.jpg'].box

const server = await createServer({
  configFile: root + 'app/vite.config.ts', root: root + 'app',
  server: { host: '127.0.0.1', port: 0 },
  resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } },
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = { chromium: await chromium.launch({ headless: true }), webkit: await webkit.launch({ headless: true }) }

const HUAWEI_UA = 'Mozilla/5.0 (Linux; Android 10; NOH-AN00 Build/HUAWEINOH-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/99.0.4844.88 HuaweiBrowser/13.0.1.300 Mobile Safari/537.36'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const DEVICES = [
  { name: 'huawei-412', engine: 'chromium', options: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: HUAWEI_UA }, shot: 'tongue-mirror-huawei.png' },
  { name: 'huawei-448', engine: 'chromium', options: { viewport: { width: 448, height: 924 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: HUAWEI_UA } },
  { name: 'sample-375', engine: 'chromium', options: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: HUAWEI_UA } },
  { name: 'iphone15pro-393', engine: 'webkit', options: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA }, shot: 'tongue-mirror-iphone.png' },
]

const report = {}
for (const device of DEVICES) {
  const context = await browser[device.engine].newContext(device.options)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    document.addEventListener('change', event => {
      const input = event.target
      if (input instanceof HTMLInputElement && input.type === 'file') {
        const file = input.files && input.files[0]
        window.__lastPickedFile = file ? { name: file.name, type: file.type, size: file.size } : null
      }
    }, true)
  })
  const control = { reply: features(CENTRAL), statuses: [], requests: [] }
  await page.route('https://synthetic.invalid/**', async route => {
    const body = route.request().postData() ?? ''
    control.requests.push(body)
    const status = control.statuses.shift()
    if (status) return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic' }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: control.reply } }] }) })
  })
  await page.route('https://geocoding-api.open-meteo.com/**', route => route.fulfill({ status: 200, body: '{}' }))
  await page.route('https://api.open-meteo.com/**', route => route.fulfill({ status: 200, body: '{}' }))
  await page.goto(`${origin}/@fs/${root}e2e/abstractor.html`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2200)
  const deviceReport = { viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })), cases: {} }

  const snapshot = () => page.evaluate(async () => {
    const data = await window.inspectAbstractor()
    const row = data.root[0]
    const value = row?.value
    return { cropId: value && value.crop ? value.crop.id : null, failureKinds: data.tongueFailures.map(item => item.value.kind) }
  })
  const failures = async () => (await snapshot()).failureKinds
  const addedKinds = (before, after) => {
    const counts = new Map()
    for (const kind of before) counts.set(kind, (counts.get(kind) ?? 0) - 1)
    for (const kind of after) counts.set(kind, (counts.get(kind) ?? 0) + 1)
    return [...counts.entries()].filter(([, delta]) => delta > 0).map(([kind]) => kind)
  }
  const alertText = () => page.locator('[role=alert]').allTextContents()
  const picked = () => page.evaluate(() => window.__lastPickedFile)

  async function captureWith(file, mime) {
    const before = await snapshot()
    const beforeAlerts = (await alertText()).join('|')
    const requestCount = control.requests.length
    await page.locator('input[type=file]').setInputFiles({ name: file, mimeType: mime, buffer: await image(file) })
    await page.waitForTimeout(800)
    await expect.poll(async () => {
      const now = await snapshot()
      const alerts = (await alertText()).join('|')
      return (now.cropId !== null && now.cropId !== before.cropId) || (alerts.length > 0 && alerts !== beforeAlerts)
    }, { timeout: 30000 }).toBe(true)
    const after = await snapshot()
    return {
      added: after.cropId !== null && after.cropId !== before.cropId ? 1 : 0,
      alerts: await alertText(),
      picked: await picked(),
      requests: control.requests.slice(requestCount),
      failureKinds: after.failureKinds,
      newFailureKinds: addedKinds(before.failureKinds, after.failureKinds),
    }
  }
  function lastImage(requests) {
    for (const body of [...requests].reverse()) {
      try {
        const parsed = JSON.parse(body)
        const url = parsed?.messages?.[1]?.content?.[0]?.image_url?.url
        if (typeof url === 'string' && url.startsWith('data:image/jpeg;base64,')) return url.split(',')[1]
      } catch { /* 只挑最后一条图请求 */ }
    }
    return null
  }
  async function jpegSize(base64) {
    if (!base64) return null
    return page.evaluate(async data => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
      try {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
        const size = { width: bitmap.width, height: bitmap.height, jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 }
        bitmap.close()
        return size
      } catch { return { jpeg: bytes[0] === 0xff && bytes[1] === 0xd8, width: 0, height: 0 } }
    }, base64)
  }

  // 1) 镜子显示：图片元素宽高比 == 原始宽高比，完整落在框内（object-fit: contain 且元素本身按比例）
  control.reply = features(CENTRAL)
  const mirror = await captureWith('tongue-normal.jpg', 'image/jpeg')
  expect(mirror.added).toBe(1)
  expect(mirror.alerts).toEqual([])
  const geometry = await page.evaluate(() => {
    const img = document.querySelector('.nl-mirror-frame img')
    const frame = img.closest('.nl-mirror-frame')
    const rect = img.getBoundingClientRect(), frameRect = frame.getBoundingClientRect()
    const style = getComputedStyle(img)
    // object-fit: contain 下实际画出来的内容尺寸：按原始宽高比缩放到元素框内，完整可见。
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight)
    const content = { width: img.naturalWidth * scale, height: img.naturalHeight * scale }
    return {
      natural: { width: img.naturalWidth, height: img.naturalHeight },
      rect: { width: rect.width, height: rect.height },
      content,
      frame: { width: frameRect.width, height: frameRect.height },
      objectFit: style.objectFit,
      fillsAxis: Math.abs(content.width - rect.width) < 0.5 || Math.abs(content.height - rect.height) < 0.5,
      inside: rect.left >= frameRect.left - 0.5 && rect.top >= frameRect.top - 0.5 && rect.right <= frameRect.right + 0.5 && rect.bottom <= frameRect.bottom + 0.5,
    }
  })
  expect(geometry.objectFit).toBe('contain')
  expect(Math.abs(geometry.rect.width / geometry.rect.height - geometry.natural.width / geometry.natural.height)).toBeLessThan(0.01)
  expect(geometry.fillsAxis).toBe(true)
  expect(geometry.inside).toBe(true)
  if (device.shot) await page.locator('section[aria-label="照镜子"]').screenshot({ path: SHOTS + device.shot })
  deviceReport.cases.mirror = { ...geometry, added: mirror.added }

  // 2) 送模型前规范化：image/jpg、大写 MIME、空 MIME、长边 6000 → 都能送出，且请求里是 ≤1600 的 JPEG
  deviceReport.cases.normalize = {}
  for (const [name, file, mime] of [
    ['image-jpg', 'tongue-normal.jpg', 'image/jpg'],
    ['uppercase', 'tongue-normal.jpg', 'IMAGE/JPEG'],
    ['empty', 'tongue-normal.jpg', ''],
    ['long-6000', 'tongue-long-6000.jpg', 'image/jpeg'],
  ]) {
    control.reply = features(CENTRAL)
    const result = await captureWith(file, mime)
    const size = await jpegSize(lastImage(result.requests))
    deviceReport.cases.normalize[name] = { added: result.added, alerts: result.alerts, picked: result.picked, requestImage: size }
    expect(result.added, name).toBeGreaterThanOrEqual(1)
    expect(result.alerts, name).toEqual([])
    expect(size?.jpeg, name).toBe(true)
    expect(Math.max(size.width, size.height), name).toBeLessThanOrEqual(1600)
  }

  // 3) 模型回复容错：围栏、前后说明、0–1000 框、多余字段都能出记录；纯乱码仍失败
  deviceReport.cases.replies = {}
  const replyCases = {
    fenced: '```json\n' + features({ x: 300, y: 420, width: 400, height: 260 }) + '\n```',
    prose: '这是本次结果：' + features({ x: 300, y: 420, width: 400, height: 260 }),
    scaledBox: features({ x: 300, y: 420, width: 400, height: 260 }),
    extraFields: features(CENTRAL, { extra: 'ignored', reason: 'x' }),
  }
  for (const [name, reply] of Object.entries(replyCases)) {
    control.reply = reply
    const result = await captureWith('tongue-normal.jpg', 'image/jpeg')
    deviceReport.cases.replies[name] = { added: result.added, alerts: result.alerts }
    expect(result.added, name).toBeGreaterThanOrEqual(1)
    expect(result.alerts, name).toEqual([])
  }
  control.reply = '纯乱码'
  const garbage = await captureWith('tongue-normal.jpg', 'image/jpeg')
  expect(garbage.added).toBe(0)
  expect(garbage.alerts.join('')).toContain('稍后再拍')
  deviceReport.cases.replies.garbage = { added: garbage.added, alerts: garbage.alerts, newFailureKinds: garbage.newFailureKinds }
  expect(garbage.newFailureKinds).toContain('model_unavailable')

  // 4) 短边门槛：面积 1%、短边 160 通过；短边 100 提示靠近
  deviceReport.cases.threshold = {}
  control.reply = features(meta['tongue-1pct-short160.jpg'].box)
  const short160 = await captureWith('tongue-1pct-short160.jpg', 'image/jpeg')
  deviceReport.cases.threshold.pass = { added: short160.added, alerts: short160.alerts }
  expect(short160.alerts).toEqual([])
  expect(short160.added).toBeGreaterThanOrEqual(1)
  control.reply = features(meta['tongue-1pct-short100.jpg'].box)
  const short100 = await captureWith('tongue-1pct-short100.jpg', 'image/jpeg')
  deviceReport.cases.threshold.fail = { added: short100.added, alerts: short100.alerts, newFailureKinds: short100.newFailureKinds }
  expect(short100.newFailureKinds).toContain('no_tongue')
  expect(short100.added).toBe(0)
  expect(short100.alerts.join('')).toContain('靠近一点再拍')

  // 5) 失败分档与重试：503 一次后成功（用户无感）；连续 503 提示稍后再拍；401 提示检查账户
  deviceReport.cases.retry = {}
  control.reply = features(CENTRAL)
  control.statuses = [503]
  const retryOnce = await captureWith('tongue-normal.jpg', 'image/jpeg')
  deviceReport.cases.retry.recovered = { added: retryOnce.added, alerts: retryOnce.alerts, requests: retryOnce.requests.length }
  expect(retryOnce.added).toBeGreaterThanOrEqual(1)
  expect(retryOnce.alerts).toEqual([])
  expect(retryOnce.requests.length).toBe(2)

  control.statuses = [503, 503]
  const retryTwice = await captureWith('tongue-normal.jpg', 'image/jpeg')
  deviceReport.cases.retry.unavailable = { added: retryTwice.added, alerts: retryTwice.alerts, requests: retryTwice.requests.length, newFailureKinds: retryTwice.newFailureKinds }
  expect(retryTwice.newFailureKinds).toContain('model_unavailable')
  expect(retryTwice.added).toBe(0)
  expect(retryTwice.alerts.join('')).toContain('稍后再拍')
  expect(retryTwice.requests.length).toBe(2)

  control.statuses = []
  control.reply = features(CENTRAL)
  await page.route('https://synthetic.invalid/**', async route => {
    control.requests.push(route.request().postData() ?? '')
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' })
  })
  const account = await captureWith('tongue-normal.jpg', 'image/jpeg')
  deviceReport.cases.retry.account = { added: account.added, alerts: account.alerts, newFailureKinds: account.newFailureKinds }
  expect(account.added).toBe(0)
  expect(account.alerts.join('')).toContain('模型账户需要检查')
  expect(account.newFailureKinds).toContain('model_account')

  // 6) HEIC：两个内核都不能解时给“格式打不开”且不调模型；记录 file.type 供 PR 说明
  const heicBase64 = (await image('tongue-synthetic.heic')).toString('base64')
  const heicDecode = await page.evaluate(async data => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0))
    try { const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/heic' })); bitmap.close(); return { ok: true } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }, heicBase64)
  const heic = await captureWith('tongue-synthetic.heic', 'image/heic')
  const heicRecorded = heic.picked
  deviceReport.cases.heic = { decodeCapable: heicDecode, picked: heicRecorded, added: heic.added, alerts: heic.alerts, requests: heic.requests.length, newFailureKinds: heic.newFailureKinds }
  if (!heicDecode.ok) {
    expect(heic.added).toBe(0)
    expect(heic.requests.length).toBe(0)
    expect(heic.alerts.join('')).toContain('这张照片的格式手机浏览器打不开')
    expect(heic.newFailureKinds).toContain('photo_format')
  }

  // 7) 失败类别只记类别，不存照片/模型原文
  const failureDump = JSON.stringify(await page.evaluate(async () => (await window.inspectAbstractor()).tongueFailures))
  expect(failureDump).not.toContain('base64')
  expect(failureDump).not.toContain('data:image')
  expect(failureDump).not.toContain('纯乱码')
  deviceReport.failureKinds = await failures()
  deviceReport.errors = errors
  expect(errors).toEqual([])
  report[device.name] = deviceReport
  await context.close()
}

for (const engine of Object.values(browser)) await engine.close()
await server.close()
await mkdir(root + '.cache/e2e', { recursive: true })
await writeFile(root + '.cache/e2e/tongue-report.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
console.log('PASS: V2-20 tongue fix — mirror 100%, image normalization, reply tolerance, short-side threshold, failure classes/retry, HEIC behavior (chromium + webkit)')
