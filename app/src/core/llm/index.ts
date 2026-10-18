import { nip98Authorization } from './nip98'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  temperature?: number
}

// baseUrl 是 OpenAI 兼容接口的根路径；后面追加 /chat/completions。
export type LlmSource =
  | { kind: 'gateway'; baseUrl: string; secretKey: Uint8Array }
  | { kind: 'api-key'; baseUrl: string; apiKey: string; model: string }
  | { kind: 'local'; baseUrl: string; model: string }

export interface LlmClient {
  complete(messages: ChatMessage[], options?: ChatOptions): Promise<string>
  stream(messages: ChatMessage[], onToken: (token: string) => void, options?: ChatOptions): Promise<string>
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('模型地址不能为空')
  return base + '/chat/completions'
}

function checkSource(source: LlmSource): void {
  if (source.kind === 'api-key' && !source.apiKey.trim()) throw new Error('API Key 不能为空')
  if (source.kind !== 'gateway' && !source.model.trim()) throw new Error('模型名称不能为空')
  endpoint(source.baseUrl)
}

function requestBody(source: LlmSource, messages: ChatMessage[], stream: boolean, options?: ChatOptions): string {
  const body: Record<string, unknown> = { messages, stream }
  if (source.kind !== 'gateway') body.model = source.model
  if (typeof options?.temperature === 'number') body.temperature = options.temperature
  return JSON.stringify(body)
}

async function send(source: LlmSource, body: string): Promise<Response> {
  const url = endpoint(source.baseUrl)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (source.kind === 'gateway') headers.authorization = await nip98Authorization(source.secretKey, url, 'POST', body)
  else if (source.kind === 'api-key') headers.authorization = 'Bearer ' + source.apiKey
  const response = await fetch(url, { method: 'POST', headers, body })
  if (!response.ok) throw new Error('模型请求失败：HTTP ' + response.status)
  return response
}

function replyText(data: ChatResponse): string {
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('上游回复缺少 choices[0].message.content')
  return content
}

export function createLlmClient(source: LlmSource, transport = send): LlmClient {
  checkSource(source)
  return {
    async complete(messages, options) {
      const response = await transport(source, requestBody(source, messages, false, options))
      return replyText(await response.json() as ChatResponse)
    },
    async stream(messages, onToken, options) {
      const response = await transport(source, requestBody(source, messages, true, options))
      if (!response.body) throw new Error('上游没有返回流式响应')
      let text = ''
      for await (const token of readTokens(response.body)) {
        text += token
        onToken(token)
      }
      return text
    },
  }
}

async function* readTokens(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const event = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          if (data === '[DONE]') return
          const token = JSON.parse(data).choices?.[0]?.delta?.content
          if (typeof token === 'string' && token) yield token
        }
        end = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}
