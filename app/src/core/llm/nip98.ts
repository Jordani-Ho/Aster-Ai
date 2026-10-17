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

// NIP-98: kind 27235，带 u（完整 URL）、method、payload（请求体 SHA-256）三个标签。
export async function nip98Authorization(secretKey: Uint8Array, url: string, method: string, body: string): Promise<string> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  const tags: string[][] = [['u', url], ['method', method], ['nonce', nonce]]
  if (body) tags.push(['payload', await sha256Hex(body)])
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '' }, secretKey)
  return 'Nostr ' + base64(JSON.stringify(event))
}
