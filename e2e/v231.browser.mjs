import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'

// V2-31 扫码登记验收（合成手机、模型/网关替身）：
// 1) 打开 #setup=<口令> 链接后，地址栏立刻清掉口令；第 2 步自动填好口令，点登记即成功
// 2) 口令只出现在提交给自家网关的 body 里，不出现在任何请求 URL 里
// 3) 手动粘贴老路（V2-28 去空格）仍可用
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const TOKEN = 'SYNTHETIC_DEPLOYMENT_TOKEN'

const server = await createServer({
  configFile: root + 'app/vite.config.ts', root: root + 'app',
  server: { host: '127.0.0.1', port: 0 },
  resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } },
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({ headless: true })

async function openPage(query, hash = '') {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } })
  const page = await context.newPage()
  const errors = []
  const requests = []
  const seedBodies = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.route('**/chat/completions', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '合成模型回答' } }] }) }))
  await page.route('https://opening.synthetic.invalid/**', route => {
    if (route.request().url().endsWith('/invite/seed')) {
      try { seedBodies.push(JSON.parse(route.request().postData() ?? '{}')) } catch { seedBodies.push(null) }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await page.goto(`${origin}/@fs/${root}e2e/opening.html?${query}${hash}`)
  return { context, page, errors, requests, seedBodies }
}

try {
  // 1) 扫码链接：#setup=<口令>
  {
    const { context, page, errors, requests, seedBodies } = await openPage('scene=guide&name=v231-scan', '#setup=' + TOKEN)
    await expect(page.getByRole('heading', { name: '让它帮您打理馆', exact: true })).toBeVisible()
    // 读到口令后立刻从地址栏清掉（刷新/截图/复制地址都不会再带口令）
    expect(await page.evaluate(() => location.hash)).toBe('')
    await page.getByLabel('模型账户密钥', { exact: true }).fill('SYNTHETIC_KEY')
    await page.getByRole('button', { name: '测试并继续', exact: true }).click()
    await expect(page.getByRole('heading', { name: '先登记您这位老师', exact: true })).toBeVisible()
    await expect(page.getByLabel('登记口令', { exact: true })).toHaveValue(TOKEN)
    await expect(page.getByText(/teacher-setup\.html/)).toBeVisible()
    await page.getByLabel('学生怎么称呼您', { exact: true }).fill('合成阿慈')
    await page.getByRole('button', { name: '登记，下一步', exact: true }).click()
    await expect(page.getByRole('heading', { name: '给您的馆起个名', exact: true })).toBeVisible()
    expect(seedBodies.at(-1)?.token).toBe(TOKEN)
    expect(await page.evaluate(() => location.hash)).toBe('')
    // 口令不能出现在任何请求 URL 里（只在提交给自家网关的 body 里）。
    expect(requests.filter(url => url.includes(TOKEN))).toEqual([])
    expect(errors).toEqual([])
    await context.close()
  }

  // 2) 手动粘贴老路仍然可用（前后空格自动去掉）
  {
    const { context, page, errors, seedBodies } = await openPage('scene=guide&name=v231-manual')
    await page.getByLabel('模型账户密钥', { exact: true }).fill('SYNTHETIC_KEY')
    await page.getByRole('button', { name: '测试并继续', exact: true }).click()
    await expect(page.getByLabel('登记口令', { exact: true })).toHaveValue('')
    await page.getByLabel('学生怎么称呼您', { exact: true }).fill('合成阿慈')
    await page.getByLabel('登记口令', { exact: true }).fill(`  ${TOKEN}  `)
    await page.getByRole('button', { name: '登记，下一步', exact: true }).click()
    await expect(page.getByRole('heading', { name: '给您的馆起个名', exact: true })).toBeVisible()
    expect(seedBodies.at(-1)?.token).toBe(TOKEN)
    expect(errors).toEqual([])
    await context.close()
  }

  console.log('PASS: V2-31 扫码链接自动填口令、地址栏清掉 #setup、请求 URL 不含口令；手动粘贴老路仍可用')
} finally {
  await browser.close()
  await server.close()
}
