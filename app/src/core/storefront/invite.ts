import type { Event } from 'nostr-tools/pure'
import { inviteLink } from '../onboarding'
import { verifyStorefrontEvent, type StorefrontEvent, type VerifiedStorefront } from './index'

// V2-09：把老师本人签名的门面事件放进邀请链接，学生打开时先验签再决定显示。
// 邀请事件与网关格式都不变，只多加一个 URL 参数；内容限长，别把链接撑爆。
export const STOREFRONT_LINK_PARAM = 'storefront'
export const MAX_STOREFRONT_LINK = 3000

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeBase64Url(encoded: string): string | null {
  try {
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch { return null }
}

export function storefrontInviteLink(base: string, invite: Event, storefront?: StorefrontEvent | null): string {
  const url = new URL(inviteLink(base, invite))
  if (storefront) {
    const encoded = encodeBase64Url(JSON.stringify(storefront))
    if (encoded.length > MAX_STOREFRONT_LINK) throw new Error('门面内容太长，无法放进邀请链接')
    url.searchParams.set(STOREFRONT_LINK_PARAM, encoded)
  }
  return url.href
}

/** 从邀请链接里取出老师门面；签名不是这位老师或内容无效时返回 null（不显示门面）。 */
export function readStorefrontLink(link: string, teacher: string): VerifiedStorefront | null {
  let url: URL
  try { url = new URL(link) } catch { return null }
  const encoded = url.searchParams.get(STOREFRONT_LINK_PARAM)
  if (!encoded || encoded.length > MAX_STOREFRONT_LINK) return null
  const decoded = decodeBase64Url(encoded)
  if (decoded === null) return null
  let parsed: unknown
  try { parsed = JSON.parse(decoded) } catch { return null }
  return verifyStorefrontEvent(parsed, teacher)
}
