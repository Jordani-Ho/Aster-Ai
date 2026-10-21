import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const server = await createServer({ configFile: root + 'app/vite.config.ts', root: root + 'app', server: { host: '127.0.0.1', port: 0 }, resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } } })
await server.listen()
const browser = await chromium.launch({ headless: true })

async function open(scene) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, permissions: ['clipboard-read', 'clipboard-write'] })
  await context.addInitScript(() => { window.__shared = null; if (navigator.share) return; Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__shared = data } }) })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${root}e2e/phone.html?scene=${scene}`)
  return { context, page, errors }
}
async function layout(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const small = await page.locator('button:visible').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent ?? '', height: node.getBoundingClientRect().height })).filter(item => item.height < 43.5))
  expect(small).toEqual([])
}
async function shot(page, name) { if (!process.env.CI) await page.screenshot({ path: root + 'docs/screenshots/phone-teacher-' + name + '.png' }) }

try {
  // 今天
  {
    const { context, page, errors } = await open('today')
    await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
    await layout(page)
    await shot(page, 'today')
    expect(errors).toEqual([])
    await context.close()
  }
  // 远程：收到问诊 → 打开 → 签字发出
  {
    const { context, page, errors } = await open('remote')
    await expect(page.getByRole('heading', { name: '远程工作台', exact: true })).toBeVisible()
    await expect(page.getByText('最近睡不好', { exact: true })).toBeVisible()
    await layout(page)
    await shot(page, 'remote')
    await page.getByRole('button', { name: '打开问诊', exact: true }).click()
    await expect(page.getByRole('heading', { name: '病历草稿', exact: true })).toBeVisible()
    await layout(page)
    expect(await page.locator('[data-long-record="no"]').count()).toBe(1)
    // 没有照片时整行不显示。
    expect(await page.getByText(/照片：\d+ 张/).count()).toBe(0)
    await page.evaluate(() => { const page = document.querySelector('.sign-page'); if (page) window.scrollTo(0, page.getBoundingClientRect().top + window.scrollY) })
    await shot(page, 'sign')
    await page.getByRole('button', { name: '签字发出', exact: true }).click()
    await expect(page.getByRole('heading', { name: '已签字交还', exact: true })).toBeVisible()
    await layout(page)
    expect(errors).toEqual([])
    await context.close()
  }
  // 面诊
  {
    const { context, page, errors } = await open('in-person')
    await expect(page.getByRole('heading', { name: '面诊工作台', exact: true })).toBeVisible()
    await layout(page)
    await shot(page, 'in-person')
    expect(errors).toEqual([])
    await context.close()
  }
  // 管理：分块、二维码可以直接分享、门面/钱账/换机
  {
    const { context, page, errors } = await open('manage')
    await expect(page.getByRole('heading', { name: '管理', exact: true })).toBeVisible()
    expect(await page.locator('details.manage-block > summary').allInnerTexts()).toEqual(['邀请学生', '我的门面', '钱账', '记录保留多久', '换手机'])
    await layout(page)
    await shot(page, 'manage')
    await page.locator('details.manage-block').filter({ hasText: /^邀请学生/ }).locator('summary').click()
    await page.getByRole('button', { name: '生成邀请', exact: true }).click()
    await expect(page.getByAltText('学生扫码即可加入')).toBeVisible()
    const link = await page.getByLabel('邀请链接', { exact: true }).inputValue()
    expect(link).toContain('invite=')
    expect(link).toContain('storefront=')
    const save = page.locator('a.invite-save')
    await expect(save).toHaveAttribute('download', 'zhihang-invite.png')
    expect(await save.getAttribute('href')).toMatch(/^data:image\/png;base64,/)
    await page.getByRole('button', { name: '分享邀请', exact: true }).click()
    expect((await page.evaluate(() => window.__shared))?.url).toBe(link)
    await page.getByRole('button', { name: '复制邀请', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '邀请已复制' })).toBeVisible()
    await layout(page)
    await shot(page, 'invite')
    await page.locator('details.manage-block').filter({ hasText: /^我的门面/ }).locator('summary').click()
    await expect(page.getByRole('region', { name: '我的门面' })).toBeVisible()
    await layout(page)
    await shot(page, 'storefront')
    await page.locator('details.manage-block').filter({ hasText: /^钱账/ }).locator('summary').click()
    await expect(page.getByRole('region', { name: '钱账与对账' })).toBeVisible()
    await layout(page)
    await shot(page, 'ledger')
    await page.locator('details.manage-block').filter({ hasText: /^换手机/ }).locator('summary').click()
    await expect(page.getByRole('region', { name: '换手机找回' })).toBeVisible()
    await layout(page)
    await shot(page, 'reidentify')
    expect(errors).toEqual([])
    await context.close()
  }
  // 长病历：分段折叠、展开全部
  {
    const { context, page, errors } = await open('long')
    await expect(page.locator('[data-long-record="yes"]')).toBeVisible()
    const sections = page.locator('details.sign-section')
    expect(await sections.count()).toBe(6)
    expect(await sections.evaluateAll(nodes => nodes.map(node => node.open))).toEqual([true, false, false, false, false, false])
    await layout(page)
    await shot(page, 'long-record')
    await page.getByRole('button', { name: '展开全部', exact: true }).click()
    expect(await sections.evaluateAll(nodes => nodes.map(node => node.open))).toEqual([true, true, true, true, true, true])
    await layout(page)
    expect(errors).toEqual([])
    await context.close()
  }
  // 舌象：切换入口不靠“放大”也常显；逐项改值整行布局
  {
    const { context, page, errors } = await open('tongue')
    await expect(page.getByRole('group', { name: '对照方式' })).toBeVisible()
    await expect(page.getByRole('button', { name: '只看裁剪图', exact: true })).toBeVisible()
    await layout(page)
    await page.getByRole('button', { name: '只看裁剪图', exact: true }).click()
    expect(await page.locator('.tongue-frames').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(1)
    await shot(page, 'tongue')
    // 逐项改值：一项一行，控件 ≥44px / 16px，窄屏不溢出。
    const rows = page.locator('.tongue-row-edit')
    expect(await rows.count()).toBe(6)
    const measured = await rows.evaluateAll(nodes => nodes.map(node => {
      const select = node.querySelector('select')
      const rect = select.getBoundingClientRect()
      return { height: rect.height, fontSize: getComputedStyle(select).fontSize, right: rect.right, width: rect.width, rowWidth: node.getBoundingClientRect().width }
    }))
    for (const item of measured) {
      expect(item.height).toBeGreaterThanOrEqual(43.5)
      expect(item.fontSize).toBe('16px')
      expect(item.right).toBeLessThanOrEqual(375)
      expect(item.width).toBeGreaterThan(item.rowWidth * 0.8)
    }
    await page.locator('.tongue-rows').scrollIntoViewIfNeeded()
    await shot(page, 'tongue-rows')
    expect(errors).toEqual([])
    await context.close()
  }
  // 建馆第 5 步：先进去看看
  {
    const { context, page, errors } = await open('opening')
    await expect(page.getByRole('heading', { name: '邀请第一位学生', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '先进去看看', exact: true }).click()
    await expect(page.getByRole('heading', { name: '已进入老师首页', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  console.log('PASS: V2-13 老师端 375px 今天/远程/签字/面诊/管理/邀请二维码分享/门面/钱账/换机/长病历折叠/舌象切换/建馆先进去看看')
} finally { await browser.close(); await server.close() }
