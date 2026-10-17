import { finalizeEvent } from 'nostr-tools/pure'

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function randomNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

// NIP-98: kind 27235，带 u（完整 URL）、method、payload（请求体 SHA-256）标签。
// 再加一个随机 nonce 标签（NIP-98 允许额外标签）：同一秒内的相同请求会得到不同的事件 id，
// 不会被网关的防重放规则误判成重放。
export async function nip98Authorization(secretKey: Uint8Array, url: string, method: string, body: string): Promise<string> {
  const tags: string[][] = [['u', url], ['method', method]]
  if (body) tags.push(['payload', await sha256Hex(body)])
  tags.push(['nonce', randomNonce()])
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, secretKey)
  return 'Nostr ' + base64(JSON.stringify(event))
}
