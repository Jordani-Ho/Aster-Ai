// 极简静态文件服务 + 同源反代。不打印任何访问日志。
// - 静态：/srv/app/dist（容器启动时刚构建好的 app）
// - 反代：/push/* 与 /v1/* 转到 compose 内部的 gateway:8787。
//   这样手机页面只与一个 HTTPS 源（app 域名或 trycloudflare 地址）通信，
//   M1-08 要求的“应用与网关同源”成立，NIP-98 里的 u 标签也与页面源一致。
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const ROOT = resolve(process.env.APP_DIST ?? '/srv/app/dist')
const PORT = Number(process.env.PORT ?? 8080)
const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? 'http://gateway:8787'
const PROXY_PREFIXES = ['/push/', '/v1/', '/invite/']
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function baseHeaders(pathname) {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  }
}

function isProxyPath(pathname) {
  return PROXY_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

function proxy(req, res) {
  const upstream = new URL(GATEWAY)
  const headers = { ...req.headers, host: upstream.host }
  delete headers.connection
  const forward = httpRequest({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || 80,
    method: req.method,
    path: req.url,
    headers,
  }, response => {
    const responseHeaders = { ...response.headers }
    delete responseHeaders.connection
    res.writeHead(response.statusCode ?? 502, responseHeaders)
    response.pipe(res)
  })
  forward.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'gateway unavailable' }))
  })
  req.pipe(forward)
}

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  let pathname
  try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname) } catch { res.writeHead(400); res.end(); return }
  if (pathname.endsWith('/')) pathname += 'index.html'
  const file = join(ROOT, normalize(pathname).replace(/^([/\\])+/, ''))
  if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(404); res.end(); return }
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    const headers = { ...baseHeaders(pathname), 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': info.size }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' })
    res.end('not found')
  }
}

createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (isProxyPath(pathname)) proxy(req, res)
  else void serveStatic(req, res)
}).listen(PORT, '0.0.0.0', () => {
  // 只打印一次启动信息，不含请求、身份或 IP。
  process.stdout.write('web static server listening on ' + PORT + '\n')
})
