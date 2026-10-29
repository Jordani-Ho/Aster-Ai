import {it} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools/pure'
import {createGateway} from '../server.js'

// V2-39：限流按路由分组。内测实测里，学生手机一进首页会连发一串推送请求，把每公钥
// 20 次 / 60 秒的共用额度吃光，后面的 /invite/redeem 就被 429 拒掉。这里把三组分开
// 计数后，推送额度用满也不能影响进馆；同一分组里超了才 429。
const teacher = generateSecretKey()
const teacherPubkey = getPublicKey(teacher)
const student = generateSecretKey()
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)))
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) })
function invite(key, url) { return finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', url + '/invite/redeem'], ['method', 'POST'], ['expiration', String(Math.floor(Date.now() / 1000) + 3600)], ['nonce', crypto.randomUUID()]], content: '{"type":"aster.invite","version":1}' }, key) }
async function post(base, path, key, body) {
  const text = JSON.stringify(body)
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', base + path], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')], ['nonce', crypto.randomUUID()]], content: '' }, key)
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64') }, body: text })
}
async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'aster-ratelimit-'))
  const membersFile = join(dir, 'members.json')
  writeFileSync(membersFile, JSON.stringify({ members: [teacherPubkey], teachers: [teacherPubkey], coreMembers: [] }))
  writeFileSync(join(dir, 'seed.json'), JSON.stringify({ tokenHash: createHash('sha256').update('SYNTHETIC_DEPLOYMENT_TOKEN').digest('hex') }))
  writeFileSync(join(dir, 'core-seed.json'), JSON.stringify({ tokenHash: createHash('sha256').update('SYNTHETIC_CORE_TOKEN').digest('hex') }))
  writeFileSync(join(dir, 'recommendations.json'), '[]')
  const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}') })
  const upstreamUrl = await listen(upstream)
  const gateway = createGateway({
    membersFile,
    seedTokenFile: join(dir, 'seed.json'),
    coreSeedTokenFile: join(dir, 'core-seed.json'),
    recommendationsFile: join(dir, 'recommendations.json'),
    upstreamBaseUrl: upstreamUrl,
    upstreamModel: 'synthetic',
    upstreamApiKeyEnv: 'ASTER_RATELIMIT_UNUSED_KEY',
    rateLimit: { windowMs: 60000, invites: { maxPerWindow: 2 }, push: { maxPerWindow: 3 }, model: { maxPerWindow: 2 } },
    logFile: join(dir, 'gateway.log'),
    push: { subscriptionsFile: join(dir, 'push.json'), send: async () => {} },
  })
  const url = await listen(gateway)
  try { await run({ url }) } finally { await close(gateway); await close(upstream); rmSync(dir, { recursive: true, force: true }) }
}
it('V2-39 推送额度用满后，同一公钥的邀请兑换仍然 200；同一分组超了才 429，模型转发另算', () => fixture(async ({ url }) => {
  const ticket = invite(teacher, url)
  // 1) 推送分组额度 3：打满，第 4 次才 429。
  for (let index = 0; index < 3; index += 1) assert.notEqual((await post(url, '/push/notify', teacher, {})).status, 429)
  assert.equal((await post(url, '/push/notify', teacher, {})).status, 429)
  // 2) 推送额度已满，同一公钥兑换邀请照样 200（旧实现这里会 429）。
  assert.equal((await post(url, '/invite/redeem', teacher, { invite: ticket })).status, 200)
  // 3) 进馆分组额度 2：再兑一次 200，第三次 429。
  assert.equal((await post(url, '/invite/redeem', teacher, { invite: ticket })).status, 200)
  assert.equal((await post(url, '/invite/redeem', teacher, { invite: ticket })).status, 429)
  // 4) 模型分组的额度不受进馆分组影响：仍能转发。
  assert.equal((await post(url, '/v1/chat/completions', teacher, { messages: [] })).status, 200)
}))
it('V2-39 两个公钥的额度互不影响', () => fixture(async ({ url }) => {
  const ticket = invite(teacher, url)
  for (let index = 0; index < 2; index += 1) assert.equal((await post(url, '/invite/redeem', student, { invite: ticket })).status, 200)
  assert.equal((await post(url, '/invite/redeem', student, { invite: ticket })).status, 429)
  // 另一个公钥的进馆额度是新的。
  assert.equal((await post(url, '/invite/redeem', teacher, { invite: ticket })).status, 200)
}))
