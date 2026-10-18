import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createMediaServer, MAX_CIPHER_BYTES, RETENTION_MS } from '../media/server.js'

const secret = generateSecretKey(), stranger = generateSecretKey()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function auth(action, hash, key = secret, extra = []) {
  const now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent({ kind: 24242, created_at: now - 1, content: 'Transfer encrypted practice video', tags: [['t', action], ['x', hash], ['server', 'app.example'], ['expiration', String(now + 60)], ...extra] }, key)
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64url')
}
async function fixture(job) {
  const cache = fileURLToPath(new URL('../../.cache/e2e/', import.meta.url))
  await mkdir(cache, { recursive: true })
  const dir = await mkdtemp(join(cache, 'media-'))
  const members = join(dir, 'members.json'), blobs = join(dir, 'blobs')
  await writeFile(members, JSON.stringify([getPublicKey(secret)]))
  let now = Date.now()
  const service = await createMediaServer({ directory: blobs, membersFile: members, publicUrl: 'https://app.example', now: () => now, sweepIntervalMs: 0 })
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + service.server.address().port
  try { await job({ url, blobs, members, service, advance: ms => { now += ms } }) }
  finally { await new Promise(resolve => { service.server.close(resolve); service.server.closeAllConnections() }); await service.close(); await rm(dir, { recursive: true, force: true }) }
}
const upload = (url, data, hash = sha(data), key = secret) => fetch(url + '/upload', { method: 'PUT', headers: { authorization: auth('upload', hash, key), 'content-type': 'application/octet-stream', 'x-sha-256': hash }, body: data })
const download = (url, hash, key = secret) => fetch(url + '/' + hash, { headers: { authorization: auth('get', hash, key) } })

test('20MB ciphertext: hash-addressed upload/download without identity metadata', () => fixture(async ({ url, blobs }) => {
  const bytes = randomBytes(20 * 1024 * 1024), hash = sha(bytes)
  const result = await upload(url, bytes)
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { sha256: hash, size: bytes.length, type: 'application/octet-stream', url: 'https://app.example/media/' + hash })
  assert.deepEqual(await readdir(blobs), [hash])
  assert.deepEqual(await readFile(join(blobs, hash)), bytes)
  const response = await download(url, hash)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.notEqual(bytes.subarray(4, 8).toString(), 'ftyp')
}))
test('membership changes apply immediately; missing, alien and ambiguous signatures fail', () => fixture(async ({ url, members }) => {
  const bytes = randomBytes(32), hash = sha(bytes)
  assert.equal((await upload(url, bytes, hash, stranger)).status, 403)
  assert.equal((await fetch(url + '/' + hash)).status, 401)
  const original = JSON.parse(Buffer.from(auth('get', hash).slice(6), 'base64url').toString())
  const expired = finalizeEvent({ kind: 24242, created_at: original.created_at, content: original.content, tags: original.tags.map(t => t[0] === 'expiration' ? ['expiration', String(Math.floor(Date.now() / 1000) - 1)] : t) }, secret)
  assert.equal((await fetch(url + '/' + hash, { headers: { authorization: 'Nostr ' + Buffer.from(JSON.stringify(expired)).toString('base64url') } })).status, 401)
  original.sig = '0'.repeat(128)
  assert.equal((await fetch(url + '/' + hash, { headers: { authorization: 'Nostr ' + Buffer.from(JSON.stringify(original)).toString('base64url') } })).status, 401)
  assert.equal((await fetch(url + '/' + hash, { headers: { authorization: auth('get', hash, secret, [['x', 'a'.repeat(64)]]) } })).status, 401)
  await writeFile(members, JSON.stringify([getPublicKey(secret), getPublicKey(stranger)]))
  assert.equal((await upload(url, bytes, hash, stranger)).status, 200)
  await writeFile(members, '[]')
  assert.equal((await download(url, hash)).status, 403)
}))
test('startup sweep honors persisted upload age after a service restart', () => fixture(async ({ url, blobs, members }) => {
  assert.equal((await upload(url, randomBytes(32))).status, 200)
  const restarted = await createMediaServer({ directory: blobs, membersFile: members, publicUrl: 'https://app.example', now: () => Date.now() + RETENTION_MS + 1000, sweepIntervalMs: 0 })
  try { assert.deepEqual(await readdir(blobs), []) } finally { await restarted.close() }
}))
test('wrong hash, oversized and non-cipher MIME uploads leave no stored files', () => fixture(async ({ url, blobs }) => {
  const bytes = randomBytes(32)
  assert.equal((await upload(url, bytes, 'a'.repeat(64))).status, 400)
  assert.equal((await fetch(url + '/upload', { method: 'PUT', headers: { authorization: auth('upload', sha(bytes)), 'x-sha-256': sha(bytes), 'content-type': 'video/mp4' }, body: bytes })).status, 415)
  assert.equal((await fetch(url + '/upload', { method: 'HEAD', headers: { authorization: auth('upload', sha(bytes)), 'x-sha-256': sha(bytes), 'x-content-length': String(MAX_CIPHER_BYTES + 1), 'x-content-type': 'application/octet-stream' } })).status, 413)
  assert.deepEqual(await readdir(blobs), [])
}))
test('access and duplicate upload do not extend 30 days; sweep removes expired bytes', () => fixture(async ({ url, blobs, service, advance }) => {
  const bytes = randomBytes(32), hash = sha(bytes)
  assert.equal((await upload(url, bytes)).status, 200)
  advance(RETENTION_MS - 1000)
  assert.equal((await download(url, hash)).status, 200)
  assert.equal((await upload(url, bytes)).status, 200)
  advance(1001)
  assert.equal((await download(url, hash)).status, 404)
  await service.sweep()
  assert.deepEqual(await readdir(blobs), [])
}))
