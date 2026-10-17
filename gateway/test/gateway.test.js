import { createServer, request as httpRequest } from 'node:http'
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
const ROUTE = '/v1/chat/completions'
const SYNTHETIC_PROMPT = 'SYNTHETIC_PROMPT_TEXT'
const SYNTHETIC_REPLY = 'SYNTHETIC_REPLY_TEXT'
const dir = mkdtempSync(join(tmpdir(), 'aster-gateway-'))
const logFile = join(dir, 'gateway.log')
const membersFile = join(dir, 'members.json')
const secretKey = generateSecretKey()
const memberPubkey = getPublicKey(secretKey)
const strangerKey = generateSecretKey()
writeFileSync(membersFile, JSON.stringify([memberPubkey]))

const upstream = { server: null, url: '', requests: [], firstWrite: 0, secondWrite: 0, hangClosed: false }

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
function close(server) {
  server.closeAllConnections?.()
  return new Promise(resolve => server.close(resolve))
}
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
function makeConfig(overrides = {}) {
  return {
    upstreamBaseUrl: upstream.url,
    upstreamModel: MODEL_A,
    upstreamApiKeyEnv: 'GATEWAY_TEST_KEY',
    membersFile,
    maxBodyBytes: 1048576,
    upstreamTimeoutMs: 5000,
    rateLimit: { windowMs: 60000, maxPerWindow: 100 },
    logFile,
    ...overrides,
  }
}
async function startGateway(overrides = {}) {
  const server = createGateway(makeConfig(overrides))
  const port = await listen(server)
  return { server, port, baseUrl: 'http://127.0.0.1:' + port }
}
function authHeader(key, url, method, body) {
  const tags = [['u', url], ['method', method]]
  if (body !== undefined) tags.push(['payload', createHash('sha256').update(body).digest('hex')])
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, key)
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64')
}
async function chat(gateway, body, key = secretKey, path = ROUTE, signal) {
  const text = JSON.stringify(body)
  const url = gateway.baseUrl + path
  const headers = { 'content-type': 'application/json' }
  if (key) headers.authorization = authHeader(key, url, 'POST', text)
  return fetch(url, { method: 'POST', headers, body: text, signal })
}
function isSynthetic(body, marker) {
  const content = body && body.messages && body.messages[0] && body.messages[0].content
  return typeof content === 'string' && content.includes(marker)
}
function rawRequest(gateway, path, headers, parts) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: gateway.port, path, method: 'POST', headers }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', error => { if (!request.destroyed) reject(error) })
    request.setTimeout(5000, () => request.destroy(new Error('client timeout')))
    for (const part of parts) request.write(part)
    request.end()
  })
}

describe('M1-07 模型网关验收', () => {
  let gateway
  before(async () => {
    upstream.server = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      upstream.requests.push({ url: req.url, headers: req.headers, body })
      if (isSynthetic(body, 'SYNTHETIC_HANG')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'SYNTHETIC_HANG_CHUNK' } }] }) + '\n\n')
        const timer = setInterval(() => {
          try {
            res.write(': keepalive\n\n')
          } catch {
            clearInterval(timer)
          }
        }, 100)
        timer.unref()
        res.on('close', () => {
          clearInterval(timer)
          upstream.hangClosed = true
        })
        return
      }
      if (isSynthetic(body, 'SYNTHETIC_SLOW')) {
        await delay(600)
        try {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content: 'SYNTHETIC_SLOW_REPLY' } }] }))
        } catch {
          // 网关已因超时断开。
        }
        return
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        upstream.firstWrite = Date.now()
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'SYNTHETIC_CHUNK_ONE' } }] }) + '\n\n')
        await delay(60)
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
    const url = gateway.baseUrl + ROUTE
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

  it('1b 只允许 POST /v1/chat/completions，其他路径一律 404', async () => {
    const seenBefore = upstream.requests.length
    for (const path of ['/v1/fine_tuning/jobs', '/v1/files', '/v1/models', '/v1/chat/completions/extra']) {
      const res = await chat(gateway, { stream: false, messages: [{ role: 'user', content: 'SYNTHETIC_PATH_PROBE' }] }, secretKey, path)
      assert.equal(res.status, 404, path)
    }
    assert.equal(upstream.requests.length, seenBefore, '非法路径不得转发到上游')
  })

  it('1c 请求体上限：声明长度超限直接 413，且不转发', async () => {
    const small = await startGateway({ maxBodyBytes: 1024 })
    try {
      const seenBefore = upstream.requests.length
      const body = Buffer.from(JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'SYNTHETIC_BIG' }] }) + ' '.repeat(4096))
      const authorization = authHeader(secretKey, small.baseUrl + ROUTE, 'POST', body.toString('utf8'))
      const result = await rawRequest(small, ROUTE, { 'content-type': 'application/json', 'content-length': body.length, authorization }, [body])
      assert.equal(result.status, 413)
      assert.equal(upstream.requests.length, seenBefore, '超限请求不得转发到上游')
    } finally {
      await close(small.server)
    }
  })

  it('1d 请求体上限：分块读取中累计超限立即 413', async () => {
    const small = await startGateway({ maxBodyBytes: 1024 })
    try {
      const authorization = authHeader(secretKey, small.baseUrl + ROUTE, 'POST', 'x')
      const parts = [Buffer.from('a'.repeat(600)), Buffer.from('b'.repeat(600)), Buffer.from('c'.repeat(600))]
      const result = await rawRequest(small, ROUTE, { 'content-type': 'application/json', authorization }, parts)
      assert.equal(result.status, 413)
    } finally {
      await close(small.server)
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

  it('3c 同一个 NIP-98 事件重放返回 401', async () => {
    const body = JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'SYNTHETIC_REPLAY' }] })
    const url = gateway.baseUrl + ROUTE
    const authorization = authHeader(secretKey, url, 'POST', body)
    const send = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body })
    assert.equal((await send()).status, 200)
    assert.equal((await send()).status, 401)
    assert.equal((await send()).status, 401)
  })

  it('4a 上游超时返回 504', async () => {
    const slow = await startGateway({ upstreamTimeoutMs: 100 })
    try {
      const started = Date.now()
      const res = await chat(slow, { stream: false, messages: [{ role: 'user', content: 'SYNTHETIC_SLOW' }] })
      assert.equal(res.status, 504)
      assert.ok(Date.now() - started < 1000, '超时后应立即返回')
    } finally {
      await close(slow.server)
    }
  })

  it('4b 客户端断开时中止上游请求', async () => {
    upstream.hangClosed = false
    const controller = new AbortController()
    const res = await chat(gateway, { stream: true, messages: [{ role: 'user', content: 'SYNTHETIC_HANG' }] }, secretKey, ROUTE, controller.signal)
    const reader = res.body.getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    controller.abort()
    const deadline = Date.now() + 2000
    while (!upstream.hangClosed && Date.now() < deadline) await delay(20)
    assert.ok(upstream.hangClosed, '客户端断开后上游连接应被中止')
  })

  it('5 超过限流返回 429', async () => {
    const limited = await startGateway({ rateLimit: { windowMs: 60000, maxPerWindow: 2 } })
    // 三条请求内容不同，事件 id 不同，避免被防重放当成同一条。
    const request = index => ({ stream: false, messages: [{ role: 'user', content: 'SYNTHETIC_RATE_' + index }] })
    try {
      assert.equal((await chat(limited, request(1))).status, 200)
      assert.equal((await chat(limited, request(2))).status, 200)
      assert.equal((await chat(limited, request(3))).status, 429)
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
    const port = await listen(server)
    try {
      const res = await chat({ baseUrl: 'http://127.0.0.1:' + port, port }, { stream: false })
      assert.equal(res.status, 200)
      assert.equal(upstream.requests[upstream.requests.length - 1].body.model, 'synthetic-model-b')
    } finally {
      await close(server)
    }
  })

  it('7 日志只有时间、公钥前 8 位、耗时、状态码，没有内容', async () => {
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
    const forbidden = [
      SYNTHETIC_PROMPT, SYNTHETIC_REPLY, 'SYNTHETIC_CHUNK_ONE', 'SYNTHETIC_CHUNK_TWO',
      'SYNTHETIC_REPLAY', 'SYNTHETIC_SLOW', 'SYNTHETIC_HANG', 'SYNTHETIC_PATH_PROBE', 'SYNTHETIC_BIG',
      memberPubkey, Buffer.from(secretKey).toString('hex'), 'synthetic-upstream-key',
    ]
    for (const text of forbidden) {
      assert.ok(!raw.includes(text), '日志中不得出现：' + text.slice(0, 12))
    }
  })
})
