// Blossom BUD-01/02/11 subset. Stores only opaque ciphertext; never logs requests.
import { createServer } from 'node:http'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, readdir, unlink, rename, utimes, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getEventHash, verifyEvent } from 'nostr-tools/pure'
import { MemberStore } from '../members.js'

export const MAX_CIPHER_BYTES = 60 * 1024 * 1024 + 16
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const HASH = /^[0-9a-f]{64}$/
const MIME = 'application/octet-stream'

export async function createMediaServer({ directory, membersFile, publicUrl, now = Date.now, sweepIntervalMs = 60000 }) {
  const origin = new URL(publicUrl)
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw Error('invalid public URL')
  const members = new MemberStore(membersFile), locks = new Map(), activeParts = new Set()
  const root = resolve(directory)
  await mkdir(root, { recursive: true, mode: 0o700 })
  let activeUploads = 0
  async function locked(hash, job) {
    const prior = locks.get(hash) ?? Promise.resolve()
    const task = prior.catch(() => {}).then(job)
    locks.set(hash, task)
    try { return await task } finally { if (locks.get(hash) === task) locks.delete(hash) }
  }
  async function info(hash) {
    try { const value = await stat(join(root, hash)); return value.isFile() ? value : null }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  async function sweep() {
    for (const name of await readdir(root)) {
      if (HASH.test(name)) await locked(name, async () => {
        const value = await info(name)
        if (value && now() - value.mtimeMs >= RETENTION_MS) await unlink(join(root, name))
      })
      else if (/^\.part-[0-9a-f-]+$/.test(name) && !activeParts.has(name)) {
        // Interrupted uploads are never downloadable. Clean crash leftovers after one hour.
        const value = await stat(join(root, name)).catch(() => null)
        if (value && now() - value.mtimeMs >= 3600000) await unlink(join(root, name)).catch(() => {})
      }
    }
  }
  const timer = sweepIntervalMs > 0 ? setInterval(() => { void sweep().catch(() => {}) }, sweepIntervalMs) : null
  timer?.unref()
  await sweep()
  function authenticate(req, action, hash) {
    try {
      const header = req.headers.authorization
      if (typeof header !== 'string' || header.length > 8192 || !/^Nostr [A-Za-z0-9_-]+$/.test(header)) return 401
      const input = JSON.parse(Buffer.from(header.slice(6), 'base64url').toString('utf8'))
      // Reconstruct standard fields: never trust verifyEvent's cached Symbol (E-004).
      const event = Object.fromEntries(['id', 'sig', 'kind', 'pubkey', 'created_at', 'tags', 'content'].map(k => [k, input[k]]))
      if (!Array.isArray(event.tags) || event.tags.some(t => !Array.isArray(t) || t.some(v => typeof v !== 'string'))) return 401
      const one = name => { const values = event.tags.filter(t => t[0] === name); return values.length === 1 && values[0].length === 2 ? values[0][1] : null }
      const seconds = Math.floor(Date.now() / 1000), expiration = one('expiration')
      if (event.kind !== 24242 || !Number.isSafeInteger(event.created_at) || event.created_at > seconds || event.created_at < seconds - 120 ||
          !expiration || !/^\d+$/.test(expiration) || Number(expiration) <= seconds || Number(expiration) > seconds + 120 ||
          one('t') !== action || one('server') !== origin.hostname || one('x') !== hash ||
          getEventHash(event) !== event.id || !verifyEvent(event)) return 401
      return members.has(event.pubkey) ? 0 : 403
    } catch { return 401 }
  }
  const server = createServer(async (req, res) => {
    const reject = (status, reason) => {
      req.on('error', () => {})
      res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'x-reason': reason, connection: 'close' })
      res.end(reason)
    }
    try {
      const upload = req.url === '/upload' && ['PUT', 'HEAD'].includes(req.method)
      const hash = upload ? req.headers['x-sha-256'] : req.url?.slice(1)
      if (!HASH.test(hash ?? '') || (!upload && !['GET', 'HEAD'].includes(req.method))) { reject(404, 'not found'); return }
      const status = authenticate(req, upload ? 'upload' : 'get', hash)
      if (status) { reject(status, status === 401 ? 'unauthorized' : 'not a member'); return }
      if (upload) {
        const sizeText = req.headers[req.method === 'HEAD' ? 'x-content-length' : 'content-length']
        const mime = req.headers[req.method === 'HEAD' ? 'x-content-type' : 'content-type']
        if (mime !== MIME) { reject(415, 'ciphertext only'); return }
        if (typeof sizeText !== 'string' || !/^\d+$/.test(sizeText)) { reject(411, 'length required'); return }
        const size = Number(sizeText)
        if (!Number.isSafeInteger(size) || size > MAX_CIPHER_BYTES || size < 17) { reject(413, 'invalid size'); return }
        if (req.method === 'HEAD') { res.writeHead(200, { 'cache-control': 'no-store' }); res.end(); return }
        if (activeUploads >= 4) { reject(503, 'busy'); return }
        activeUploads++
        const name = '.part-' + randomUUID(), temp = join(root, name)
        activeParts.add(name)
        try {
          let received = 0
          const digest = createHash('sha256')
          const meter = new Transform({ transform(chunk, _encoding, next) {
            received += chunk.length
            if (received > size || received > MAX_CIPHER_BYTES) { next(Error('size')); return }
            digest.update(chunk); next(null, chunk)
          } })
          // A detached source avoids pipeline destroying the response socket on a bad upload.
          req.pipe(meter)
          req.on('aborted', () => meter.destroy(Error('interrupted')))
          req.on('error', () => meter.destroy(Error('interrupted')))
          await pipeline(meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }))
          if (received !== size || digest.digest('hex') !== hash) { reject(400, 'hash mismatch'); return }
          const fd = await open(temp, 'r+')
          try { await fd.sync() } finally { await fd.close() }
          await locked(hash, async () => {
            const existing = await info(hash)
            if (existing && now() - existing.mtimeMs < RETENTION_MS) return
            if (existing) await unlink(join(root, hash))
            const at = new Date(now())
            await utimes(temp, at, at)
            await rename(temp, join(root, hash))
          })
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ sha256: hash, size, type: MIME, url: origin.origin + '/media/' + hash }))
        } finally {
          activeUploads--; activeParts.delete(name)
          await unlink(temp).catch(() => {})
        }
      } else {
        const value = await info(hash)
        if (!value || now() - value.mtimeMs >= RETENTION_MS) { reject(404, 'not found'); return }
        res.writeHead(200, { 'content-type': MIME, 'content-length': value.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        if (req.method === 'HEAD') res.end()
        else await pipeline(createReadStream(join(root, hash)), res)
      }
    } catch {
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.destroy()
        else reject(500, 'transfer failed')
      }
    }
  })
  server.requestTimeout = 300000
  server.headersTimeout = 30000
  return { server, sweep, close: async () => { if (timer) clearInterval(timer); await Promise.allSettled([...locks.values()]) } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await createMediaServer({ directory: process.env.MEDIA_DIRECTORY ?? '/app/media', membersFile: '/app/data/members.json', publicUrl: process.env.MEDIA_PUBLIC_URL })
  service.server.listen(3040, '0.0.0.0')
}
