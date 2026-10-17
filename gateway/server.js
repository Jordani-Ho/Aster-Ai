import { createPushService, PUSH_ROUTES } from './push/index.js'
import { createServer } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { verifyEvent } from 'nostr-tools/pure'

const ROUTE = '/v1/chat/completions'
const AUTH_WINDOW_SECONDS = 60
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000

function loadConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function createGateway(config) {
  const members = new Set(JSON.parse(readFileSync(config.membersFile, 'utf8')))
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS
  const push = config.push ? createPushService({ file: config.push.subscriptionsFile ?? './push-subscriptions.json', endpointHosts: config.push.endpointHosts, send: config.push.send }) : null
  const hits = new Map()
  const seen = new Map()
  const log = record => {
    const line = JSON.stringify(record) + '\n'
    if (config.logFile) appendFileSync(config.logFile, line)
    else process.stdout.write(line)
  }
  const reply = (res, status, error, close = false) => {
    const headers = { 'content-type': 'application/json' }
    if (close) headers.connection = 'close'
    res.writeHead(status, headers)
    res.end(JSON.stringify({ error }))
  }

  // 只读到上限为止；超限立刻停下，不把整个请求体读进内存。
  function readBody(req) {
    return new Promise(resolve => {
      const chunks = []
      let size = 0
      let done = false
      const finish = result => {
        if (done) return
        done = true
        req.removeAllListeners('data')
        resolve(result)
      }
      req.on('data', chunk => {
        if (done) return
        size += chunk.length
        if (size > maxBodyBytes) {
          req.pause()
          finish({ tooLarge: true })
        } else chunks.push(chunk)
      })
      req.on('end', () => finish({ body: Buffer.concat(chunks) }))
      req.on('aborted', () => finish({ aborted: true }))
      req.on('error', () => finish({ aborted: true }))
    })
  }

  // NIP-98：签名、时间窗、u、method、payload，并拒绝 60 秒内重放的事件 id。
  function authenticate(req, body) {
    try {
      const header = req.headers.authorization
      if (typeof header !== 'string' || !header.startsWith('Nostr ')) return { status: 401 }
      const event = JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8'))
      const tag = name => event.tags.find(entry => entry[0] === name)?.[1]
      const url = (config.publicUrl ?? 'http://' + req.headers.host) + req.url
      const payloadHash = createHash('sha256').update(body).digest('hex')
      const fresh = Math.abs(Date.now() / 1000 - event.created_at) <= AUTH_WINDOW_SECONDS
      const valid = verifyEvent(event) && event.kind === 27235 && fresh &&
        tag('u') === url && tag('method') === req.method && tag('payload') === payloadHash
      if (!valid) return { status: 401 }
      if (!members.has(event.pubkey)) return { status: 403 }
      const now = Date.now()
      for (const [id, expires] of seen) if (expires <= now) seen.delete(id)
      if (seen.has(event.id)) return { status: 401 }
      seen.set(event.id, now + AUTH_WINDOW_SECONDS * 1000)
      return { status: 0, pubkey: event.pubkey }
    } catch {
      return { status: 401 }
    }
  }

  function allowed(pubkey) {
    const now = Date.now()
    const { windowMs, maxPerWindow } = config.rateLimit
    const recent = (hits.get(pubkey) ?? []).filter(at => now - at < windowMs)
    const permitted = recent.length < maxPerWindow
    if (permitted) recent.push(now)
    hits.set(pubkey, recent)
    return permitted
  }

  async function forward(req, res, body) {
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      reply(res, 400, 'invalid json')
      return 400
    }
    payload.model = config.upstreamModel
    const controller = new AbortController()
    const timeout = AbortSignal.timeout(upstreamTimeoutMs)
    const abortOnClose = () => {
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', abortOnClose)
    try {
      const upstream = await fetch(config.upstreamBaseUrl.replace(/\/$/, '') + req.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + (process.env[config.upstreamApiKeyEnv] ?? ''),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([timeout, controller.signal]),
      })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk)
      res.end()
      return upstream.status
    } catch {
      if (res.destroyed || res.writableEnded) return 499
      const status = timeout.aborted ? 504 : 502
      if (res.headersSent) res.end()
      else reply(res, status, status === 504 ? 'upstream timeout' : 'upstream failed')
      return status
    } finally {
      res.off('close', abortOnClose)
    }
  }

  return createServer(async (req, res) => {
    const started = Date.now()
    let status = 500
    let pubkey = ''
    const reject = (code, message) => {
      req.on('error', () => {})
      reply(res, code, message, true)
    }
    try {
      // 只放行一个路径：成员不能借用上游账户的微调、文件等接口。
      if (req.url !== ROUTE && !PUSH_ROUTES.includes(req.url)) {
        status = 404
        reject(404, 'not found')
      } else if (req.method !== 'POST') {
        status = 405
        reject(405, 'method not allowed')
      } else if (!req.headers.authorization) {
        status = 401
        reject(401, 'unauthorized')
      } else if (Number(req.headers['content-length']) > maxBodyBytes) {
        status = 413
        reject(413, 'payload too large')
      } else {
        const read = await readBody(req)
        if (read.tooLarge) {
          status = 413
          reject(413, 'payload too large')
        } else if (read.aborted) {
          status = 499
        } else {
          const auth = authenticate(req, read.body)
          status = auth.status
          pubkey = auth.pubkey ?? ''
          if (status === 401) reply(res, 401, 'unauthorized')
          else if (status === 403) reply(res, 403, 'not a member')
          else if (!allowed(pubkey)) {
            status = 429
            reply(res, 429, 'too many requests')
           } else if (req.url === ROUTE) status = await forward(req, res, read.body)
          else if (!push) { status = 503; reply(res, 503, 'push unavailable') }
          else {
            let body
            try { body = JSON.parse(read.body) } catch { status = 400; reply(res, 400, 'invalid json'); return }
            const result = await push.handle(req.url, pubkey, body)
            status = result.status
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: status < 400 }))
          }
        }
      }
    } catch {
      status = 502
      if (!res.headersSent) reply(res, 502, 'gateway error')
      else res.end()
    } finally {
      log({ time: new Date().toISOString(), pubkey: pubkey.slice(0, 8), durationMs: Date.now() - started, status })
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.argv[2] ?? fileURLToPath(new URL('./config.json', import.meta.url)))
  createGateway(config).listen(config.port ?? 8787)
}
