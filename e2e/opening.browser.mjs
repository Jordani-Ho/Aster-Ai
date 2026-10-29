import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const server = await createServer({ configFile: root + 'app/vite.config.ts', root: root + 'app', server: { host: '127.0.0.1', port: 0 }, resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/chat/completions', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '合成模型回答' } }] }) }))
  await page.route('https://opening.synthetic.invalid/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${root}e2e/opening.html?scene=guide&name=opening-guide-browser`)

  // 05a：第一步只接模型；旧的顶层导航不出现。
  await expect(page.getByRole('heading', { name: '让它帮您打理馆', exact: true })).toBeVisible()
  await expect(page.getByText('建馆 · 第 1 / 5 步', { exact: true })).toBeVisible()
  expect(await page.getByRole('button', { name: '管理', exact: true }).count()).toBe(0)
  expect(await page.getByText('钱账', { exact: true }).count()).toBe(0)
  expect(await page.getByText('换门面', { exact: true }).count()).toBe(0)
  await page.getByRole('button', { name: '其他', exact: true }).click()
  await page.getByLabel('接口地址', { exact: true }).fill('https://model.synthetic.example/v1')
  await page.getByLabel('模型名称', { exact: true }).fill('synthetic')
  await page.getByLabel('模型账户密钥', { exact: true }).fill('SYNTHETIC')
  await page.getByRole('button', { name: '测试并继续', exact: true }).click()

  // 05b：登记称呼 + 登记口令。
  await expect(page.getByRole('heading', { name: '先登记您这位老师', exact: true })).toBeVisible()
  await page.getByLabel('学生怎么称呼您', { exact: true }).fill('合成阿慈')
  await page.getByLabel('登记口令', { exact: true }).fill('SYNTHETIC_DEPLOYMENT_TOKEN')
  await page.getByRole('button', { name: '登记，下一步', exact: true }).click()

  // 05c：馆名/一句介绍/颜色 + 小预览；第 3 步关掉再打开能接着走。
  await expect(page.getByRole('heading', { name: '给您的馆起个名', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '给您的馆起个名', exact: true })).toBeVisible()
  await expect(page.getByText('建馆 · 第 3 / 5 步', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '就用这个名字', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('名字')
  await page.getByLabel('馆名', { exact: true }).fill('合成养生馆')
  await page.getByRole('button', { name: '就用这个名字', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('介绍')
  await expect(page.getByRole('heading', { name: '给您的馆起个名' })).toBeVisible()
  await page.getByLabel('一句介绍', { exact: true }).fill('一起照顾日常作息。')
  await page.getByRole('button', { name: /暖白/ }).click()
  await expect(page.getByText('合成阿慈老师邀请你', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '就用这个名字', exact: true }).click()

  // 05d：开馆三件事 + 开馆。
  await expect(page.getByText('✓ 模型已接好', { exact: true })).toBeVisible()
  await expect(page.getByText('✓ 老师已登记', { exact: true })).toBeVisible()
  await expect(page.getByText('✓ 门面已备好', { exact: true })).toBeVisible()
  if (!process.env.CI) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('heading', { name: '开馆基础工作', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: root + 'docs/screenshots/v222-hall-groundwork-390.png' })
    await page.setViewportSize({ width: 375, height: 812 })
  }
  await expect(page.getByRole('button', { name: '开馆', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '就这样，保存模板', exact: true }).click()
  await expect(page.getByRole('button', { name: '就这样，保存排班', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '就这样，保存排班', exact: true })).toBeVisible()
  await page.getByLabel('每时段最多接待几位', { exact: true }).fill('0')
  await page.getByRole('button', { name: '就这样，保存排班', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('1–20')
  await expect(page.getByRole('button', { name: '开馆', exact: true })).toBeDisabled()
  await page.getByLabel('每时段最多接待几位', { exact: true }).fill('1')
  await page.evaluate(() => window.__opening.failNextSave())
  await page.getByRole('button', { name: '就这样，保存排班', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('没保存成功')
  await expect(page.getByRole('alert')).toContainText('SYNTHETIC_DISK_FULL')
  await page.reload()
  await expect(page.getByRole('button', { name: '就这样，保存排班', exact: true })).toBeVisible()
  await page.getByText('周一至周日的排班（展开修改）').click()
  await page.getByLabel('周一第1段开始').fill('09:30')
  await page.getByRole('button', { name: '就这样，保存排班', exact: true }).click()
  await page.getByRole('button', { name: '排班 · 已确认', exact: true }).click()
  await page.getByText('周一至周日的排班（展开修改）').click()
  await expect(page.getByLabel('周一第1段开始')).toHaveValue('09:30')
  await page.getByRole('button', { name: '邀约方式 · 还没看', exact: true }).click()
  for (const label of ['邀约方式', '药材库', '保留期限', '模型']) {
      if (label === '药材库') await page.getByLabel('不备药', { exact: true }).check()
      await page.getByRole('button', { name: '就这样，保存' + label, exact: true }).click()
    }
    await expect(page.getByRole('button', { name: '开馆', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '开馆', exact: true }).click()

  // 05e：1 小时邀请、二维码、重新生成。
  await expect(page.getByRole('heading', { name: '请第一位来面诊的学生当面扫码', exact: true })).toBeVisible()
  await expect(page.getByText('这份邀请 1 小时有效', { exact: true })).toBeVisible()
  await page.locator('details.op-link-details > summary').click()
  const invite = await page.getByLabel('邀请链接', { exact: true }).inputValue()
  expect(invite).toContain('invite=')
  expect(invite).toContain('storefront=')
  expect(await page.locator('img.op-qr').count()).toBe(1)

  await page.evaluate(() => window.__opening.expireInvite())
  await page.reload()
  await expect(page.locator('.op-qr-missing')).toHaveText('邀请已过期')
  await page.getByRole('button', { name: /重新生成邀请/ }).click()
  await expect.poll(() => page.getByLabel('邀请链接', { exact: true }).inputValue()).not.toBe(invite)
  const regenerated = await page.getByLabel('邀请链接', { exact: true }).inputValue()
  expect(regenerated).not.toBe(invite)

  // 第一位学生加入后引导结束，进入首页。
  await page.evaluate(() => window.__opening.addFirstStudent())
  await expect(page.getByText('一位学生已进馆，正在填基础信息')).toBeVisible()
  await expect(page.getByRole('button', { name: '开始面诊', exact: true })).toHaveCount(0)
  await page.evaluate(() => window.__opening.addStudent('b'))
  await page.evaluate(() => window.__opening.readyStudent('b', '合成小红', 200))
  await expect(page.getByText('合成小红已进馆', { exact: false })).toBeVisible()
  await expect(page.getByText('一位学生已进馆，正在填基础信息')).toHaveCount(0)
  await page.evaluate(() => window.__opening.readyStudent('a', '合成小明', 300))
  await expect(page.getByText('合成小明已进馆', { exact: false })).toBeVisible()
  await expect(page.getByText('合成小红已进馆', { exact: false })).toBeVisible()
  const choices = page.locator('[aria-label=已填好基础信息的学生]')
  await expect(choices.locator('button').first()).toContainText('合成小明')
  // 主按钮必须有绿色底：建馆页不在 .nl-shell 里，曾因取不到 --nl-accent 变成白底白字。
  const primaryBg = await choices.locator('button').first().evaluate(node => getComputedStyle(node).backgroundColor)
  if (primaryBg !== 'rgb(47, 93, 74)') throw new Error('建馆页主按钮底色不对：' + primaryBg)
  await choices.getByRole('button', { name: /合成小红/ }).click()
  await expect(page.getByRole('heading', { name: '已进入老师首页', exact: true })).toBeVisible()
  await expect(page.getByText('b'.repeat(64), { exact: true })).toBeVisible()

  // 08：开馆后的“我的馆”首页与设置入口。
  const manage = await browser.newPage({ viewport: { width: 375, height: 812 } })
  manage.on('pageerror', error => errors.push(error.message))
  await manage.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${root}e2e/opening.html?scene=manage&name=opening-manage-browser`)
  await expect(manage.getByRole('heading', { name: '我的馆', exact: true })).toBeVisible()
  await expect(manage.getByText('已开馆', { exact: true })).toBeVisible()
  await manage.getByRole('button', { name: '开馆准备', exact: true }).click()
  for (const label of ['模板', '排班', '邀约方式', '药材库', '保留期限', '模型']) {
    await expect(manage.getByText(`${label} · 还没看`, { exact: true })).toBeVisible()
  }
  await manage.getByRole('button', { name: '返回', exact: true }).first().click()
  await expect(manage.getByRole('button', { name: '＋ 邀请学生', exact: true })).toBeVisible()
  await expect(manage.getByRole('region', { name: '钱账总览' })).toContainText('还没记过账')
  await manage.getByRole('button', { name: /门面/ }).click()
  await expect(manage.getByRole('heading', { name: '我的门面', exact: true })).toBeVisible()
  await manage.getByRole('button', { name: '返回', exact: true }).click()
  await manage.locator('.hall-row').filter({ hasText: '设置' }).click()
  for (const label of ['记录保留多久', '换手机', '向社区分享运行统计', '我的镜子']) await expect(manage.getByRole('button', { name: new RegExp(label) })).toBeVisible()
  await manage.close()

  expect(errors).toEqual([])
  console.log('PASS: V2-38 五步建馆、六项确认与我的馆')
} finally { await browser.close(); await server.close() }
