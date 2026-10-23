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
  await page.route('https://model.synthetic.invalid/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }) }))
  await page.route('https://opening.synthetic.invalid/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${root}e2e/opening.html?scene=guide&name=opening-guide-browser`)
  await expect(page.getByText('第 1 步，共 5 步', { exact: true })).toBeVisible()
  expect(await page.getByRole('button', { name: '管理', exact: true }).count()).toBe(0)
  expect(await page.getByText('钱账', { exact: true }).count()).toBe(0)
  expect(await page.getByText('换门面', { exact: true }).count()).toBe(0)

  await page.getByLabel('选择服务商', { exact: true }).selectOption('other')
  await page.getByLabel('接口地址', { exact: true }).fill('https://model.synthetic.invalid/v1')
  await page.getByLabel('模型名称', { exact: true }).fill('synthetic')
  await page.getByLabel('接入凭证', { exact: true }).fill('SYNTHETIC')
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(page.getByText('✓ 连接成功', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '下一步', exact: true }).click()

  await expect(page.getByRole('heading', { name: '登记为社区老师', exact: true })).toBeVisible()
  await page.getByLabel('部署口令', { exact: true }).fill('SYNTHETIC_DEPLOYMENT_TOKEN')
  await page.getByRole('button', { name: '登记为社区老师', exact: true }).click()
  await expect(page.getByRole('heading', { name: '给馆起名', exact: true })).toBeVisible()

  // 验收 4：第 3 步关掉再打开，从第 3 步接着走。
  await page.reload()
  await expect(page.getByRole('heading', { name: '给馆起名', exact: true })).toBeVisible()
  await expect(page.getByText('第 3 步，共 5 步', { exact: true })).toBeVisible()

  await page.getByLabel('馆名', { exact: true }).fill('合成养生馆')
  await page.getByLabel('学生怎么称呼您', { exact: true }).fill('合成阿慈')
  await page.getByLabel(/短介绍/).fill('一起照顾日常作息。')
  await expect(page.getByText('合成阿慈老师邀请你', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(page.getByRole('heading', { name: '开馆', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '开馆', exact: true }).click()
  await expect(page.getByRole('heading', { name: '邀请第一位学生', exact: true })).toBeVisible()
  const invite = await page.getByLabel('邀请链接', { exact: true }).inputValue()
  expect(invite).toContain('invite=')
  expect(invite).toContain('storefront=')

  // 验收 2：邀请过期后显示“已过期”，重新生成出新链接。
  await page.evaluate(() => window.__opening.expireInvite())
  await page.reload()
  await expect(page.getByText('邀请已过期', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect.poll(() => page.getByLabel('邀请链接', { exact: true }).inputValue()).not.toBe(invite)
  const regenerated = await page.getByLabel('邀请链接', { exact: true }).inputValue()
  expect(regenerated).not.toBe(invite)

  // 验收 1：第一位学生加入后引导结束，进入首页。
  await page.evaluate(() => window.__opening.addFirstStudent())
  await expect(page.getByRole('heading', { name: '已进入老师首页', exact: true })).toBeVisible()

  // 验收 3：开馆后管理页按顺序分块、默认折叠。
  const manage = await browser.newPage({ viewport: { width: 375, height: 812 } })
  manage.on('pageerror', error => errors.push(error.message))
  await manage.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${root}e2e/opening.html?scene=manage&name=opening-manage-browser`)
  await expect(manage.getByRole('heading', { name: '我的馆', exact: true })).toBeVisible()
  const titles = await manage.locator('details.manage-block > summary').allInnerTexts()
  expect(titles).toEqual(['邀请学生', '我的门面', '钱账', '记录保留多久', '换手机', '向社区分享运行统计', '我的镜子'])
  expect(await manage.locator('details.manage-block').evaluateAll(nodes => nodes.map(node => node.open))).toEqual([false, false, false, false, false, false, false])
  await manage.locator('details.manage-block').filter({ hasText: /^钱账/ }).locator('summary').click()
  await expect(manage.getByText(/等待连接社区中继|学生连上社区后就会出现在这里/).first()).toBeVisible()
  await manage.close()

  expect(errors).toEqual([])
  console.log('PASS: V2-15 五步建馆、第 3 步续走、1 小时邀请、过期重生成、第一位学生后进首页、管理页分块顺序与默认折叠')
} finally { await browser.close(); await server.close() }
