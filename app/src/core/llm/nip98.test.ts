import { expect, it, vi } from 'vitest'
import { generateSecretKey, verifyEvent } from 'nostr-tools/pure'
import { nip98Authorization, sha256Hex } from './nip98'

it('同一秒相同请求有独立随机 nonce 和事件 id，签名与绑定字段仍有效', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1792180000000)
  try {
    const key = generateSecretKey()
    const url = 'https://gateway.example/v1/chat/completions'
    const body = '{"messages":[]}'
    const decode = (header: string) => JSON.parse(atob(header.slice(6)))
    const first = decode(await nip98Authorization(key, url, 'POST', body))
    const second = decode(await nip98Authorization(key, url, 'POST', body))
    expect(first.created_at).toBe(second.created_at)
    expect(first.id).not.toBe(second.id)
    const nonces = [first, second].map(event => Object.fromEntries(event.tags).nonce)
    expect(nonces[0]).toMatch(/^[0-9a-f]{32}$/)
    expect(nonces[1]).not.toBe(nonces[0])
    for (const event of [first, second]) {
      expect(verifyEvent(event)).toBe(true)
      const tags = Object.fromEntries(event.tags)
      expect(tags.u).toBe(url)
      expect(tags.method).toBe('POST')
      expect(tags.payload).toBe(await sha256Hex(body))
    }
  } finally { vi.restoreAllMocks() }
})
