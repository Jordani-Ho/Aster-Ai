import { createServer } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { verifyEvent } from 'nostr-tools/pure'

const AUTH_WINDOW_SECONDS = 60

function loadConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function createGateway(config) {
  const members = new Set(JSON.parse(readFileSync(config.membersFile, 'utf8')))
  const hits = new Map()
  const log = record => {
    const line = JSON.stringify(record) + '\n'
    if (config.logFile) appendFileSync(config.logFile, line)
    else process.stdout.write(line)
  }
  const reply = (res, status, error) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error }))
  }

  function authenticate(req, body) {
    try {
      const [scheme, encoded] = (req.headers.authorization ?? '').split(' ')
      if (scheme !== 'Nostr' || !encoded) return { status: 401 }
      const event = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
      const tag = name => event.tags.find(entry => entry[0] === name)?.[1]
      const url = (config.publicUrl ?? 'http://' + req.headers.host) + req.url
      const payloadHash = createHash('sha256').update(body).digest('hex')
      const fresh = Math.abs(Date.now() / 1000 - event.created_at) <= AUTH_WINDOW_SECONDS
      const valid = verifyEvent(event) && event.kind === 27235 && fresh &&
        tag('u') === url && tag('method') === req.method &&
        (body.length === 0 || tag('payload') === payloadHash)
      if (!valid) return { status: 401 }
      if (!members.has(event.pubkey)) return { status: 403 }
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
    const upstream = await fetch(config.upstreamBaseUrl.replace(/\/$/, '') + req.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + (process.env[config.upstreamApiKeyEnv] ?? ''),
      },
      body: JSON.stringify(payload),
    })
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk)
    res.end()
    return upstream.status
  }

  return createServer(async (req, res) => {
    const started = Date.now()
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    let status = 404
    let pubkey = ''
    try {
      const auth = req.url?.startsWith('/v1/') ? authenticate(req, body) : { status: 404 }
      status = auth.status
      pubkey = auth.pubkey ?? ''
      if (status === 404) reply(res, 404, 'not found')
      else if (status === 401) reply(res, 401, 'unauthorized')
      else if (status === 403) reply(res, 403, 'not a member')
      else if (req.method !== 'POST') { status = 405; reply(res, 405, 'method not allowed') }
      else if (!allowed(pubkey)) { status = 429; reply(res, 429, 'too many requests') }
      else status = await forward(req, res, body)
    } catch {
      status = 502
      if (res.headersSent) res.end()
      else reply(res, 502, 'upstream failed')
    } finally {
      log({ time: new Date().toISOString(), pubkey: pubkey.slice(0, 8), durationMs: Date.now() - started, status })
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.argv[2] ?? fileURLToPath(new URL('./config.json', import.meta.url)))
  createGateway(config).listen(config.port ?? 8787)
}
