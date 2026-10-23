import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const server = await createServer({ configFile: root + 'app/vite.config.ts', root: root + 'app', server: { host: '127.0.0.1', port: 0 }, resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } }, define: { 'import.meta.env.VITE_DASHBOARD_PUBKEY': JSON.stringify('d'.repeat(64)), 'import.meta.env.VITE_DASHBOARD_URL': JSON.stringify('https://phone.synthetic.invalid/#dashboard') } })
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
async function shot(page, name) { if (!process.env.CI) await page.screenshot({ path: root + 'docs/screenshots/' + name + '.png' }) }

try {
  // 老师·今天（01）+ 等您签字 → 同一个核对页 → 逐块就这样 → 签字发出
  {
    const { context, page, errors } = await open('today')
    await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '学生到了？', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /开始面诊/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: '等您签字', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /合成小王/ })).toContainText('最近睡不好')
    await expect(page.getByRole('heading', { name: '学生动态', exact: true })).toBeVisible()
    await expect(page.getByText('合成小王 这周只练了 2 天', { exact: true })).toBeVisible()
    await layout(page)
    await shot(page, 'phone-teacher-today')

    await page.getByRole('button', { name: /合成小王/ }).click()
    await expect(page.getByRole('heading', { name: /· 核对$/ })).toBeVisible()
    await expect(page.getByText(/还有 \d+ 处草稿等您确认/)).toBeVisible()
    await expect(page.getByRole('button', { name: '签字发出', exact: true })).toBeDisabled()
    await layout(page)
    for (let guard = 0; guard < 12; guard += 1) {
      const draft = page.locator('.nl-review-block.draft').first()
      if (await draft.count() === 0) break
      await draft.getByRole('button', { name: '就这样', exact: true }).first().click()
    }
    await expect(page.getByText('都确认了，可以签字发出。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '签字发出', exact: true })).toBeEnabled()
    await layout(page)
    await page.getByRole('button', { name: '签字发出', exact: true }).click()
    await expect(page.getByRole('heading', { name: '已签字交还', exact: true })).toBeVisible()
    await layout(page)
    expect(errors).toEqual([])
    await context.close()
  }
  // 老师·面诊进行中（02）→ 说一段 → 四格自动填并标来源 → 看草稿 → 逐块确认 → 签字发出
  {
    const { context, page, errors } = await open('visit')
    await page.getByRole('button', { name: /开始面诊/ }).click()
    await expect(page.getByRole('heading', { name: '开始面诊', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /学生 1/ }).click()
    await expect(page.getByLabel('您说，智能体记', { exact: true })).toBeVisible()
    await layout(page)
    await page.getByLabel('您说，智能体记', { exact: true }).fill('舌淡红，苔薄白；入睡难；脉细弱')
    await page.getByRole('button', { name: '整理', exact: true }).click()
    const look = page.getByRole('button', { name: '四诊 look' })
    await expect(look).toContainText('舌淡红，苔薄白')
    await expect(look).toContainText('听到了，待您确认')
    await expect(page.getByRole('button', { name: '四诊 ask' })).toContainText('入睡难')
    await expect(page.getByRole('button', { name: '四诊 pulse' })).toContainText('脉细弱')
    await layout(page)
    await shot(page, 'phone-teacher-visit')
    await page.getByRole('button', { name: '说完了，看草稿', exact: true }).click()
    await expect(page.getByRole('heading', { name: /· 核对$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: '签字发出', exact: true })).toBeDisabled()
    await layout(page)
    await shot(page, 'phone-teacher-review')
    for (let guard = 0; guard < 12; guard += 1) {
      const draft = page.locator('.nl-review-block.draft').first()
      if (await draft.count() === 0) break
      await draft.getByRole('button', { name: '就这样', exact: true }).first().click()
    }
    await expect(page.getByRole('button', { name: '签字发出', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '签字发出', exact: true }).click()
    await expect(page.getByRole('heading', { name: '已签字交还', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // 学生·首页（04）：四块一屏可见，打卡圆圈点一下变对勾
  {
    const { context, page, errors } = await open('student')
    await expect(page.getByRole('heading', { name: /早上好|中午好|下午好|晚上好|夜深了/ })).toBeVisible()
    await expect(page.getByRole('region', { name: '天时与今日调养' })).toContainText('霜降养脾胃')
    await expect(page.getByRole('region', { name: '照镜子' })).toBeVisible()
    await expect(page.getByRole('region', { name: '今日作业' })).toContainText('泡脚十五分钟')
    await expect(page.getByRole('button', { name: /不舒服？告诉/ })).toBeVisible()
    const last = await page.getByRole('button', { name: /不舒服？告诉/ }).boundingBox()
    expect(last.y + last.height).toBeLessThanOrEqual(730)
    await layout(page)
    await shot(page, 'phone-student-today')
    const circle = page.getByRole('button', { name: '打卡：泡脚十五分钟', exact: true })
    await expect(circle).toHaveAttribute('aria-pressed', 'false')
    await circle.click()
    await expect(circle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('已记在这台手机上', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // 我的馆：V2-15 分块原样挪进来
  {
    const { context, page, errors } = await open('manage')
    await page.getByRole('button', { name: '我的馆', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的馆', exact: true })).toBeVisible()
    expect(await page.locator('details.manage-block > summary').allInnerTexts()).toEqual(['邀请学生', '我的门面', '钱账', '记录保留多久', '换手机', '向社区分享运行统计', '我的镜子'])
    await layout(page)
    await shot(page, 'phone-teacher-manage')
    expect(errors).toEqual([])
    await context.close()
  }
  // 长病历：分段折叠、展开全部
  {
    const { context, page, errors } = await open('long')
    await expect(page.locator('[data-long-record="yes"]')).toBeVisible()
    const blocks = page.locator('details.nl-review-block')
    expect(await blocks.count()).toBe(3)
    expect(await blocks.evaluateAll(nodes => nodes.map(node => node.open))).toEqual([true, false, false])
    await layout(page)
    await page.getByRole('button', { name: '展开全部', exact: true }).click()
    expect(await blocks.evaluateAll(nodes => nodes.map(node => node.open))).toEqual([true, true, true])
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
  // 只读社区仪表盘：没有解密钥匙不显示数据，页面上没有任何操作控件
  {
    const { context, page, errors } = await open('dashboard')
    await expect(page.getByRole('heading', { name: '社区仪表盘', exact: true })).toBeVisible()
    await expect(page.getByText('没有解密钥匙，不显示任何数据。', { exact: true })).toBeVisible()
    expect(await page.locator('button, input, select, textarea, a, form').count()).toBe(0)
    expect(errors).toEqual([])
    await context.close()
  }
  console.log('PASS: V2-16 新界面 375px 今天/面诊进行中/核对签字/学生首页/我的馆/长病历折叠/舌象/建馆/仪表盘')
} finally { await browser.close(); await server.close() }
