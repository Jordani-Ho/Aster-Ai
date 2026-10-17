import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { startGatewayFixture, SYNTHETIC_DRAFT } from './gateway-fixture.mjs'
import { actors } from './actors.mjs'
const requireApp = createRequire(new URL('../app/package.json', import.meta.url))
const { finalizeEvent } = requireApp('nostr-tools/pure')
const cleanups = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function auth(actor, url, body) {
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(body).digest('hex')], ['nonce', crypto.randomUUID()]], content: '' }, Uint8Array.from(actor.key))
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64')
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'aster-e2e-fixture-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const service = await startGatewayFixture({ directory, members: [actors.teacher.pubkey, actors.student.pubkey] })
  cleanups.push(() => service.close())
  return { ...service, directory }
}
async function post(service, actor, route, payload) {
  const body = JSON.stringify(payload), url = service.url + route
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth(actor, url, body) }, body })
}
test('real gateway keeps NIP-98 + membership while upstream returns fixed synthetic draft, never echoing input', async () => {
  const service = await fixture(), route = '/v1/chat/completions'
  assert.equal((await fetch(service.url + route, { method: 'POST' })).status, 401)
  assert.equal((await post(service, actors.outsider, route, { messages: [] })).status, 403)
  const response = await post(service, actors.teacher, route, { messages: [{ role: 'user', content: 'MUST_NOT_ECHO_OR_LOG' }] })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(JSON.parse(result.choices[0].message.content), SYNTHETIC_DRAFT)
  const logs = await readFile(path.join(service.directory, 'gateway.log'), 'utf8')
  assert.ok(!logs.includes('MUST_NOT_ECHO_OR_LOG'))
  assert.equal(service.stats.upstream, 1)
})
test('streaming response ends cleanly with the same synthetic content', async () => {
  const service = await fixture()
  const response = await post(service, actors.teacher, '/v1/chat/completions', { stream: true, messages: [] })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const text = await response.text()
  assert.match(text, /\[DONE\]/)
  const frame = JSON.parse(text.split('\n')[0].slice(6))
  assert.deepEqual(JSON.parse(frame.choices[0].delta.content), SYNTHETIC_DRAFT)
})
test('push executes actual subscribe/notify routes with an injected delivery stub; no cloud request', async () => {
  const service = await fixture()
  const subscription = { endpoint: 'https://fcm.googleapis.com/e2e-synthetic', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } }
  assert.equal((await post(service, actors.student, '/push/subscribe', { subscription })).status, 200)
  assert.equal((await post(service, actors.teacher, '/push/notify', { pubkey: actors.student.pubkey })).status, 202)
  assert.equal(service.stats.pushes, 1)
  assert.equal(service.stats.lastPushText, '知衡：有新消息')
  assert.equal((await post(service, actors.teacher, '/push/notify', { pubkey: actors.outsider.pubkey })).status, 202)
  assert.equal(service.stats.pushes, 1)
})
test('cleanup closes gateway and upstream listeners', async () => {
  const service = await fixture()
  await service.close()
  await assert.rejects(fetch(service.url + '/v1/chat/completions', { method: 'POST' }))
  await assert.rejects(fetch(service.upstreamUrl + '/v1/chat/completions', { method: 'POST' }))
})
