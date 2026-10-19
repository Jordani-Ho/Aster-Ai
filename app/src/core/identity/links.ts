import type { StoreValue } from '../store'

// V2-07 换手机：本机记住“旧公钥 → 新公钥”的换机关系。
// - 学生端：旧老师公钥 → 新老师公钥（学生点“是”后写）；旧学生公钥 → 新学生公钥（老师确认后写）。
// - 老师端：旧老师公钥 → 新老师公钥（学生点“是”后由学生确认消息写入）；
//           旧学生公钥 → 新学生公钥（老师点“是”后写）。
// - V2-07b 家人认回：家人账户在这里也是独立的学生身份，直接复用 kind: 'student' 的关系，
//   由后续卡写旧家人公钥 → 新家人公钥；本卡不写家人关系。
// 名单显示、签名校验与收件过滤都按这个映射。只存公钥，不存任何记录内容。
export const IDENTITY_LINKS = 'identity-links'

export type IdentityLinkKind = 'student' | 'teacher'

export interface IdentityLink {
  kind: IdentityLinkKind
  oldKey: string
  newKey: string
  at: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function validIdentityLink(value: unknown): value is IdentityLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const link = value as Record<string, unknown>
  return (link.kind === 'student' || link.kind === 'teacher')
    && typeof link.oldKey === 'string' && HEX64.test(link.oldKey)
    && typeof link.newKey === 'string' && HEX64.test(link.newKey)
    && link.oldKey !== link.newKey
    && typeof link.at === 'string' && Number.isFinite(Date.parse(link.at))
}

// 集合键直接用旧公钥（64 位十六进制，符合本机存储键名规则）；类型写在值里。
export function linkRowKey(_kind: IdentityLinkKind, oldKey: string): string {
  return oldKey
}

export interface IdentityLinkReader { list(collection: string): Promise<{ key: string; value: unknown }[]> }
export interface IdentityLinkWriter { put(collection: string, key: string, value: unknown): Promise<void> }

export async function listIdentityLinks(store: IdentityLinkReader): Promise<IdentityLink[]> {
  const result: IdentityLink[] = []
  for (const row of await store.list(IDENTITY_LINKS)) {
    const value = row.value
    if (validIdentityLink(value)) result.push({ ...value })
  }
  return result
}

export async function saveIdentityLink(
  store: IdentityLinkWriter,
  kind: IdentityLinkKind,
  oldKey: string,
  newKey: string,
  at = new Date(),
): Promise<IdentityLink> {
  if (kind !== 'student' && kind !== 'teacher') throw new Error('换机关系类型无效')
  if (!HEX64.test(oldKey) || !HEX64.test(newKey)) throw new Error('换机关系公钥无效')
  const link: IdentityLink = { kind, oldKey, newKey, at: at.toISOString() }
  // 旧新相同（重复确认或同一个人）不写关系。
  if (oldKey === newKey) return link
  await store.put(IDENTITY_LINKS, linkRowKey(kind, oldKey), link as unknown as StoreValue)
  return link
}

/** 指向某位新公钥的所有旧公钥（按类型）。 */
export function oldKeysFor(links: readonly IdentityLink[], kind: IdentityLinkKind, newKey: string): string[] {
  return [...new Set(links.filter(link => link.kind === kind && link.newKey === newKey).map(link => link.oldKey))]
}

/** 旧公钥对应的新公钥；没有换机关系返回 null。 */
export function mappedNewKey(links: readonly IdentityLink[], kind: IdentityLinkKind, oldKey: string): string | null {
  return links.find(link => link.kind === kind && link.oldKey === oldKey)?.newKey ?? null
}
