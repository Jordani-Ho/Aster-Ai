import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { createLlmClient, type ChatMessage } from './index'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const messages: ChatMessage[] = [{ role: 'user', content: 'SYNTHETIC_PROMPT' }]

function stubFetch(response: Response) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return response
  }))
  return calls
}

function sse(parts: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonReply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('模型客户端', () => {
  it('社区网关请求带 NIP-98 签名，且不发送 model', async () => {
    const secretKey = generateSecretKey()
    const calls = stubFetch(jsonReply('SYNTHETIC_REPLY'))
    const client = createLlmClient({ kind: 'gateway', baseUrl: 'https://gateway.example/v1/', secretKey })
    expect(await client.complete(messages)).toBe('SYNTHETIC_REPLY')

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe('https://gateway.example/v1/chat/completions')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    const event = JSON.parse(Buffer.from(headers.authorization.slice('Nostr '.length), 'base64').toString('utf8'))
    expect(verifyEvent(event)).toBe(true)
    expect(event.pubkey).toBe(getPublicKey(secretKey))
    expect(event.kind).toBe(27235)
    const tags = Object.fromEntries(event.tags)
    expect(tags.u).toBe(url)
    expect(tags.method).toBe('POST')
    expect(tags.payload).toBe(createHash('sha256').update(String(init.body)).digest('hex'))
    const sent = JSON.parse(String(init.body))
    expect(sent).not.toHaveProperty('model')
    expect(sent.messages).toEqual(messages)
    expect(sent.stream).toBe(false)
  })

  it('自有 API Key 用 Bearer 头并带上模型', async () => {
    const calls = stubFetch(jsonReply('SYNTHETIC_REPLY'))
    const client = createLlmClient({ kind: 'api-key', baseUrl: 'https://api.example/v1', apiKey: 'synthetic-key', model: 'synthetic-model' })
    expect(await client.complete(messages, { temperature: 0.2 })).toBe('SYNTHETIC_REPLY')
    const { url, init } = calls[0]
    expect(url).toBe('https://api.example/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer synthetic-key')
    const sent = JSON.parse(String(init.body))
    expect(sent.model).toBe('synthetic-model')
    expect(sent.temperature).toBe(0.2)
  })

  it('本地模型地址不带任何鉴权头', async () => {
    const calls = stubFetch(jsonReply('SYNTHETIC_REPLY'))
    const client = createLlmClient({ kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'synthetic-local' })
    expect(await client.complete(messages)).toBe('SYNTHETIC_REPLY')
    const { url, init } = calls[0]
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(JSON.parse(String(init.body)).model).toBe('synthetic-local')
  })

  it('流式返回按分片解析，跨分片的内容不丢字', async () => {
    const calls = stubFetch(sse([
      'data: {"choices":[{"delta":{"content":"SYNTHETIC_ONE"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"_TWO"}}]}\n\ndata: [DONE]\n\n',
    ]))
    const client = createLlmClient({ kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'synthetic-local' })
    const tokens: string[] = []
    const text = await client.stream(messages, token => tokens.push(token))
    expect(tokens).toEqual(['SYNTHETIC_ONE', '_TWO'])
    expect(text).toBe('SYNTHETIC_ONE_TWO')
    expect(JSON.parse(String(calls[0].init.body)).stream).toBe(true)
  })

  it('上游报错时只抛状态码，不回显回复内容', async () => {
    stubFetch(new Response('SYNTHETIC_UPSTREAM_BODY', { status: 401 }))
    const client = createLlmClient({ kind: 'gateway', baseUrl: 'https://gateway.example/v1', secretKey: generateSecretKey() })
    let message = ''
    try {
      await client.complete(messages)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('HTTP 401')
    expect(message).not.toContain('SYNTHETIC_UPSTREAM_BODY')
  })

  it('拒绝空地址、空 API Key 和空模型名', () => {
    expect(() => createLlmClient({ kind: 'local', baseUrl: ' ', model: 'm' })).toThrow('模型地址不能为空')
    expect(() => createLlmClient({ kind: 'api-key', baseUrl: 'https://api.example/v1', apiKey: ' ', model: 'm' })).toThrow('API Key 不能为空')
    expect(() => createLlmClient({ kind: 'local', baseUrl: 'https://api.example/v1', model: ' ' })).toThrow('模型名称不能为空')
  })
})
