import { describe, expect, it, vi } from 'vitest'
import { createLlmClient, isQuotaExceeded, LlmRequestError } from './index'
import { ModelRequestError } from './personal'

// V2-19：只认状态码 402/429，不读上游回复正文。
describe('V2-19 额度超限识别', () => {
  it('自家模型的 ModelRequestError 与带 HTTP 状态的错误都能识别', () => {
    expect(isQuotaExceeded(new ModelRequestError(402))).toBe(true)
    expect(isQuotaExceeded(new ModelRequestError(429))).toBe(true)
    expect(isQuotaExceeded(new LlmRequestError(402))).toBe(true)
    expect(isQuotaExceeded(new Error('模型请求失败：HTTP 429'))).toBe(true)
  })

  it('余额不足以外的错误不算额度超限', () => {
    expect(isQuotaExceeded(new ModelRequestError(401))).toBe(false)
    expect(isQuotaExceeded(new ModelRequestError(500))).toBe(false)
    expect(isQuotaExceeded(new Error('timeout'))).toBe(false)
    expect(isQuotaExceeded(new Error('模型请求失败：HTTP 401'))).toBe(false)
    expect(isQuotaExceeded(null)).toBe(false)
    expect(isQuotaExceeded('模型请求失败：HTTP 402')).toBe(false)
  })

  it('上游返回 402 时抛出的错误带状态，消息里只有状态码、没有回复正文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('SYNTHETIC_UPSTREAM_BODY', { status: 402 })))
    try {
      const client = createLlmClient({ kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'synthetic-local' })
      let error: unknown
      try { await client.complete([{ role: 'user', content: '合成' }]) } catch (cause) { error = cause }
      expect(isQuotaExceeded(error)).toBe(true)
      expect(String(error)).toContain('HTTP 402')
      expect(String(error)).not.toContain('SYNTHETIC_UPSTREAM_BODY')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
