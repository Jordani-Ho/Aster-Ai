// 生产构建冒烟：用静态服务打开 app/dist，必须渲染出首屏、无页面错误。dev server 测不出分块循环这类问题。
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
const dir = process.argv[2] ?? new URL('../app/dist', import.meta.url).pathname
const types = { '.js':'text/javascript', '.html':'text/html', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' }
const server = createServer(async (req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html'; try { const b = await readFile(join(dir, p)); res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' }); res.end(b) } catch { try { const b = await readFile(join(dir, 'index.html')); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b) } catch { res.writeHead(404); res.end() } } })
await new Promise(r => server.listen(0, r))
const browser = await chromium.launch()
const origin = `http://127.0.0.1:${server.address().port}/`
async function open(role, expected) {
  const context = await browser.newContext(), page = await context.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  await page.goto(origin)
  try {
    await page.getByRole('button', { name: role, exact: true }).click({ timeout: 15000 })
    await page.getByText(expected).first().waitFor({ timeout: 15000 })
  } catch {
    console.error('FAIL: 生产构建「' + role + '」没出来', JSON.stringify({ text: (await page.locator('body').innerText()).slice(0, 300), errors }))
    process.exitCode = 1
  }
  // 离线环境里网关、中继连不上会有网络错误；这里只拦脚本错误（白屏的那一类）。
  const fatal = errors.filter(text => !/Failed to load resource|net::ERR|WebSocket/.test(text))
  if (fatal.length) { console.error('FAIL: 「' + role + '」有页面错误', JSON.stringify(fatal)); process.exitCode = 1 }
  await context.close()
}
await open('我是老师', '让它帮您打理馆')
await open('我是学生', '接入您的大模型')
await browser.close(); server.close()
if (!process.exitCode) console.log('PASS: 生产构建首屏、老师端、学生端都能打开')
