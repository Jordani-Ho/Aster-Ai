import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// V2-09：真实 Chromium + 真实组件 + 普通 IndexedDB，验证两种门面首屏、老师改门面后预览/生效/恢复，
// 并用 375px 截图交 docs/screenshots/。不连中继、不调用真实模型，只用合成馆名与介绍。
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const server = await createServer({ configFile: root + 'app/vite.config.ts', root: root + 'app', server: { host: '127.0.0.1', port: 0 }, resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${root}e2e/storefront.html`)

  // 1. 阿慈养生馆：标志、馆名、“阿慈老师邀请你”、短介绍、一个“开始使用”
  const aci = page.locator('.storefront-welcome')
  await expect(aci.getByRole('heading', { name: '阿慈养生馆', exact: true })).toBeVisible()
  await expect(aci.getByText('阿慈老师邀请你', { exact: true })).toBeVisible()
  await expect(aci.getByText('一起照顾日常作息，慢慢练成适合自己的习惯。', { exact: true })).toBeVisible()
  await expect(aci.getByRole('button', { name: '开始使用', exact: true })).toBeVisible()
  await expect(aci.locator('svg.venue-emblem')).toHaveCount(1)
  // 卡已改：邀请首屏不加免责句
  expect(await aci.innerText()).not.toContain('不替代')
  const aciColor = await aci.evaluate(node => getComputedStyle(node).backgroundColor)
  if (!process.env.CI) await aci.screenshot({ path: resolve(root, 'docs/screenshots/storefront-aci-375.png') })

  // 2. 小黄运动馆：同一套代码换配置，名字、标志、颜色、介绍都不一样
  await page.getByRole('button', { name: '小黄邀请', exact: true }).click()
  const huang = page.locator('.storefront-welcome')
  await expect(huang.getByRole('heading', { name: '小黄运动馆', exact: true })).toBeVisible()
  await expect(huang.getByText('小黄老师邀请你', { exact: true })).toBeVisible()
  expect(await huang.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(aciColor)
  if (!process.env.CI) await huang.screenshot({ path: resolve(root, 'docs/screenshots/storefront-huang-375.png') })

  // 3. 老师改门面：直接改 → 学生视角预览 → 用这个样子 → 恢复上次样子
  await page.getByRole('button', { name: '老师的门面', exact: true }).click()
  const preview = page.locator('[data-testid=storefront-preview]')
  await expect(preview.getByRole('heading', { name: '阿慈养生馆', exact: true })).toBeVisible()
  await page.getByLabel('馆名', { exact: true }).fill('小黄运动馆')
  await page.getByLabel('显示称呼', { exact: true }).fill('小黄')
  await expect(preview.getByRole('heading', { name: '小黄运动馆', exact: true })).toBeVisible()
  await expect(preview.getByText('小黄老师邀请你', { exact: true })).toBeVisible()
  await page.getByLabel(/^颜色/).selectOption('cool')
  if (!process.env.CI) await page.locator('section[aria-label="我的门面"]').screenshot({ path: resolve(root, 'docs/screenshots/storefront-teacher-375.png') })
  await page.getByRole('button', { name: '用这个样子', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已用这个样子' })).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.storefrontState())).own.name).toBe('小黄运动馆')
  const afterPublish = await page.evaluate(() => window.storefrontState())
  expect(afterPublish.previous.name).toBe('阿慈养生馆')

  await page.getByRole('button', { name: '恢复上次样子', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已恢复上次样子' })).toBeVisible()
  await expect(preview.getByRole('heading', { name: '阿慈养生馆', exact: true })).toBeVisible()
  await expect.poll(async () => (await page.evaluate(() => window.storefrontState())).previous.name).toBe('小黄运动馆')

  // 4. 重开页面后仍是已生效的那一版（门面存在本机，断网也能用）
  await page.reload()
  await expect(page.locator('.storefront-welcome').getByRole('heading', { name: '阿慈养生馆', exact: true })).toBeVisible()

  // 5. 学生跟两位老师：默认上次用的馆；切换后门牌、问诊收件人和钱账一起切
  await page.getByRole('button', { name: '学生切换老师', exact: true }).click()
  await expect(page.locator('.teacher-venue')).toHaveText('阿慈养生馆 · 阿慈老师')
  await page.getByRole('button', { name: '其他', exact: true }).click()
  await page.locator('summary').filter({ hasText: /^设置$/ }).click()
  await page.getByRole('region', { name: '我的老师' }).getByRole('button', { name: '切换到这里', exact: true }).click()
  await expect(page.locator('.teacher-venue')).toHaveText('小黄运动馆 · 小黄老师')
  await page.getByRole('button', { name: '问诊', exact: true }).click()
  await expect(page.getByText('发给小黄老师', { exact: true })).toBeVisible()
  if (!process.env.CI) await page.screenshot({ path: resolve(root, 'docs/screenshots/storefront-switch-375.png') })
  await page.getByRole('button', { name: '其他', exact: true }).click()
  await page.locator('summary').filter({ hasText: /^设置$/ }).click()
  await page.locator('summary').filter({ hasText: /^钱账与对账$/ }).click()
  await expect(page.getByText('在小黄老师这里的余额', { exact: true })).toBeVisible()

  expect(errors).toEqual([])
  console.log('PASS: 邀请首屏 × 2 套配置、老师改门面预览/用这个样子/恢复上次样子、重开仍可用、两位老师切换门牌/问诊/钱账；375px 截图已写入 docs/screenshots/')
} finally {
  await browser.close()
  await server.close()
}
