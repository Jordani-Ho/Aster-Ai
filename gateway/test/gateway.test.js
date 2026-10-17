import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createGateway } from '../server.js'

process.env.GATEWAY_TEST_KEY = 'synthetic-upstream-key'
const MODEL_A = 'synthetic-model-a'
const SYNTHETIC_PROMPT = 'SYNTHETIC_PROMPT_TEXT'
const SYNTHETIC_REPLY = 'SYNTHETIC_REPLY_TEXT'
const dir = mkdtempSync(join(tmpdir(), 'aster-gateway-'))
const logFile = join(dir, 'gateway.log')
const membersFile = join(dir, 'members.json')
const secretKey = generateSecretKey()
const memberPubkey = getPublicKey(secretKey)
const strangerKey = generateSecretKey()
writeFileSync(membersFile, JSON.stringify([memberPubkey]))

const upstream = { server: null, url: '', requests: [], firstWrite: 0, secondWrite: 0 }

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
function close(server) {
  return new Promise(resolve => server.close(resolve))
}
function makeConfig(overrides = {}) {
  return {
    upstreamBaseUrl: upstream.url,
    upstreamModel: MODEL_A,
    upstreamApiKeyEnv: 'GATEWAY_TEST_KEY',
    membersFile,
    rateLimit: { windowMs: 60000, maxPerWindow: 100 },
    logFile,
    ...overrides,
  }
}
async function startGateway(overrides = {}) {
  const server = createGateway(makeConfig(overrides))
  const port = await listen(server)
  return { server, baseUrl: 'http://127.0.0.1:' + port }
}
function authHeader(key, url, method, body) {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', createHash('sha256').update(body).digest('hex')])
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, key)
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64')
}
async function chat(gateway, body, key = secretKey) {
  const text = JSON.stringify(body)
  const url = gateway.baseUrl + '/v1/chat/completions'
  const headers = { 'content-type': 'application/json' }
  if (key) headers.authorization = authHeader(key, url, 'POST', text)
  return fetch(url, { method: 'POST', headers, body: text })
}

describe('M1-07 模型网关验收', () => {
  let gateway
  before(async () => {
    upstream.server = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      upstream.requests.push({ url: req.url, headers: req.headers, body })
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        upstream.firstWrite = Date.now()
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'SYNTHETIC_CHUNK_ONE' } }] }) + '\n\n')
        await new Promise(resolve => setTimeout(resolve, 60))
        upstream.secondWrite = Date.now()
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'SYNTHETIC_CHUNK_TWO' } }] }) + '\n\n')
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'synthetic', choices: [{ message: { content: SYNTHETIC_REPLY } }] }))
      }
    })
    upstream.url = 'http://127.0.0.1:' + await listen(upstream.server)
    gateway = await startGateway()
  })
  after(async () => {
    await close(gateway.server)
    await close(upstream.server)
  })

  it('1 没有签名或签名无效返回 401', async () => {
    const url = gateway.baseUrl + '/v1/chat/completions'
    const text = JSON.stringify({ stream: false })
    const staleEvent = finalizeEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000) - 3600,
      tags: [['u', url], ['method', 'POST'], ['payload', createHash('sha256').update(text).digest('hex')]],
      content: '',
    }, secretKey)
    const variants = [
      undefined,
      'Nostr not-base64',
      'Bearer ' + authHeader(secretKey, url, 'POST', text).slice(6),
      authHeader(secretKey, url + '?x=1', 'POST', text),
      authHeader(secretKey, url, 'GET', text),
      authHeader(secretKey, url, 'POST', text.replace('false', 'true')),
      'Nostr ' + Buffer.from(JSON.stringify(staleEvent)).toString('base64'),
    ]
    for (const authorization of variants) {
      const headers = { 'content-type': 'application/json' }
      if (authorization) headers.authorization = authorization
      const res = await fetch(url, { method: 'POST', headers, body: text })
      assert.equal(res.status, 401, String(authorization))
    }
  })

  it('2 非成员公钥返回 403', async () => {
    const res = await chat(gateway, { stream: false }, strangerKey)
    assert.equal(res.status, 403)
  })

  it('3a 成员请求拿到上游回复', async () => {
    const seenBefore = upstream.requests.length
    const res = await chat(gateway, { model: 'client-sent-model', stream: false, messages: [{ role: 'user', content: SYNTHETIC_PROMPT }] })
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.choices[0].message.content, SYNTHETIC_REPLY)
    const seen = upstream.requests[seenBefore]
    assert.equal(seen.body.model, MODEL_A)
    assert.equal(seen.headers.authorization, 'Bearer ' + process.env.GATEWAY_TEST_KEY)
    assert.equal(seen.body.messages[0].content, SYNTHETIC_PROMPT)
  })

  it('3b 流式返回正常且不缓冲', async () => {
    const res = await chat(gateway, { stream: true, messages: [{ role: 'user', content: SYNTHETIC_PROMPT }] })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let firstReadAt = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!firstReadAt) firstReadAt = Date.now()
      text += decoder.decode(value, { stream: true })
    }
    assert.match(text, /SYNTHETIC_CHUNK_ONE/)
    assert.match(text, /SYNTHETIC_CHUNK_TWO/)
    assert.ok(firstReadAt > 0 && firstReadAt < upstream.secondWrite, '第一个分片应在上游写完之前到达')
  })

  it('5 超过限流返回 429', async () => {
    const limited = await startGateway({ rateLimit: { windowMs: 60000, maxPerWindow: 2 } })
    try {
      assert.equal((await chat(limited, { stream: false })).status, 200)
      assert.equal((await chat(limited, { stream: false })).status, 200)
      assert.equal((await chat(limited, { stream: false })).status, 429)
    } finally {
      await close(limited.server)
    }
  })

  it('6 改一行配置即可切换上游模型', async () => {
    const raw = readFileSync(new URL('../config.json', import.meta.url), 'utf8')
    const switched = raw.replace('"upstreamModel": "deepseek-chat"', '"upstreamModel": "synthetic-model-b"')
    assert.notEqual(switched, raw, 'config.json 中应有 upstreamModel 一行')
    const config = JSON.parse(switched)
    config.upstreamBaseUrl = upstream.url
    config.membersFile = membersFile
    config.logFile = logFile
    const server = createGateway(config)
    const baseUrl = 'http://127.0.0.1:' + await listen(server)
    try {
      const res = await chat({ baseUrl }, { stream: false })
      assert.equal(res.status, 200)
      assert.equal(upstream.requests[upstream.requests.length - 1].body.model, 'synthetic-model-b')
    } finally {
      await close(server)
    }
  })

  it('4 日志只有时间、公钥前 8 位、耗时、状态码，没有内容', async () => {
    const lines = readFileSync(logFile, 'utf8').trim().split('\n')
    assert.ok(lines.length > 0)
    for (const line of lines) {
      const record = JSON.parse(line)
      assert.deepEqual(Object.keys(record).sort(), ['durationMs', 'pubkey', 'status', 'time'])
      assert.ok(record.pubkey.length <= 8)
      assert.equal(typeof record.durationMs, 'number')
      assert.equal(typeof record.status, 'number')
      assert.ok(!Number.isNaN(Date.parse(record.time)))
    }
    const raw = lines.join('\n')
    assert.ok(lines.some(line => JSON.parse(line).pubkey === memberPubkey.slice(0, 8)))
    const forbidden = [SYNTHETIC_PROMPT, SYNTHETIC_REPLY, 'SYNTHETIC_CHUNK_ONE', 'SYNTHETIC_CHUNK_TWO', memberPubkey, Buffer.from(secretKey).toString('hex'), 'synthetic-upstream-key']
    for (const text of forbidden) {
      assert.ok(!raw.includes(text), '日志中不得出现：' + text.slice(0, 12))
    }
  })
})
