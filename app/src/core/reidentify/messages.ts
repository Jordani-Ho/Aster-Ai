import type { Event } from 'nostr-tools/pure'
import type { LocalStore, StoreValue } from '../store'
import type { Envelope } from '../transport'
import { inviteLink, readInviteLink } from '../onboarding'

// V2-07 换手机认回的传输消息。找回链接负责“通知”，这里只放请求、确认、拒绝三种：
// - reidentify.request：学生换机时，新学生身份 → 老师（自称“我是原来的某某”）；
// - reidentify.confirm：确认换机关系（老师点“是” → 学生；学生点“是” → 新老师）；
// - reidentify.reject：老师点“不是”时回一条作废通知，不带任何记录。
// 回发病历仍复用 V2-05 的 records.backup。
export const REIDENTIFY_REQUEST = 'reidentify.request'
export const REIDENTIFY_CONFIRM = 'reidentify.confirm'
export const REIDENTIFY_REJECT = 'reidentify.reject'
/** 老师端待确认的换机请求，键为新学生公钥。 */
export const REIDENTIFY_REQUESTS = 'reidentify-requests'
/** 学生端收到的“老师没确认”通知时间；只做提示，不改名单与记录。 */
export const REIDENTIFY_REJECTED_SETTING = 'reidentify-rejected'

export type ReidentifyPurpose = 'student' | 'teacher'
export type ReidentifyLinkKind = ReidentifyPurpose

export interface PendingReidentifyRequest { student: string; alias: string; receivedAt: string }

const HEX64 = /^[0-9a-f]{64}$/
const MAX_ALIAS = 12

export function validReidentifyAlias(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= MAX_ALIAS && !/[\u0000-\u001f\u007f]/.test(value)
}

export function requestEnvelope(alias: string): Envelope {
  const value = typeof alias === 'string' ? alias.trim() : ''
  if (!validReidentifyAlias(value)) throw new Error('称呼需要 1 至 12 个字')
  return { type: REIDENTIFY_REQUEST, version: 1, payload: { alias: value } }
}

export function confirmEnvelope(purpose: ReidentifyPurpose, oldKey: string, newKey: string): Envelope {
  if (purpose !== 'student' && purpose !== 'teacher') throw new Error('换机确认类型无效')
  if (!HEX64.test(oldKey) || !HEX64.test(newKey)) throw new Error('换机确认公钥无效')
  return { type: REIDENTIFY_CONFIRM, version: 1, payload: { purpose, oldKey, newKey } }
}

export function rejectEnvelope(purpose: ReidentifyPurpose): Envelope {
  return { type: REIDENTIFY_REJECT, version: 1, payload: { purpose } }
}

export function parseReidentifyRequest(payload: unknown): { alias: string } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const alias = (payload as { alias?: unknown }).alias
  return validReidentifyAlias(alias) ? { alias: alias.trim() } : null
}

export function parseReidentifyConfirm(payload: unknown): { purpose: ReidentifyPurpose; oldKey: string; newKey: string } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = payload as { purpose?: unknown; oldKey?: unknown; newKey?: unknown }
  if (value.purpose !== 'student' && value.purpose !== 'teacher') return null
  if (typeof value.oldKey !== 'string' || !HEX64.test(value.oldKey)) return null
  if (typeof value.newKey !== 'string' || !HEX64.test(value.newKey) || value.newKey === value.oldKey) return null
  return { purpose: value.purpose, oldKey: value.oldKey, newKey: value.newKey }
}

export function parseReidentifyReject(payload: unknown): { purpose: ReidentifyPurpose } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const purpose = (payload as { purpose?: unknown }).purpose
  return purpose === 'student' || purpose === 'teacher' ? { purpose } : null
}

// 老师端待确认请求：同一新学生公钥只留最新一条。
export async function saveReidentifyRequest(store: Pick<LocalStore, 'put'>, student: string, alias: string): Promise<PendingReidentifyRequest | null> {
  if (!HEX64.test(student) || !validReidentifyAlias(alias)) return null
  const request: PendingReidentifyRequest = { student, alias: alias.trim(), receivedAt: new Date().toISOString() }
  await store.put(REIDENTIFY_REQUESTS, student, request as unknown as StoreValue)
  return request
}

export async function listReidentifyRequests(store: Pick<LocalStore, 'list'>): Promise<PendingReidentifyRequest[]> {
  const result: PendingReidentifyRequest[] = []
  for (const row of await store.list(REIDENTIFY_REQUESTS)) {
    const value = row.value as Partial<PendingReidentifyRequest> | undefined
    if (!value || typeof value !== 'object') continue
    if (typeof value.student !== 'string' || !HEX64.test(value.student) || value.student !== row.key) continue
    if (!validReidentifyAlias(value.alias)) continue
    if (typeof value.receivedAt !== 'string' || !Number.isFinite(Date.parse(value.receivedAt))) continue
    result.push({ student: value.student, alias: value.alias.trim(), receivedAt: value.receivedAt })
  }
  return result.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt))
}

export async function dropReidentifyRequest(store: Pick<LocalStore, 'delete'>, student: string): Promise<void> {
  await store.delete(REIDENTIFY_REQUESTS, student)
}

export async function markReidentifyRejected(store: Pick<LocalStore, 'put'>, at = new Date()): Promise<void> {
  await store.put('settings', REIDENTIFY_REJECTED_SETTING, at.toISOString() as unknown as StoreValue)
}

export async function reidentifyRejectedAt(store: Pick<LocalStore, 'get'>): Promise<string | null> {
  const value = await store.get('settings', REIDENTIFY_REJECTED_SETTING)
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

const REIDENTIFY_PARAM = 'reidentify'
const NAME_PARAM = 'name'

/** 换机找回链接：普通邀请链接 + URL 参数（reidentify=student|teacher，可选老师称呼）。 */
export function reidentifyLink(base: string, event: Event, kind: ReidentifyLinkKind, name?: string): string {
  if (kind !== 'student' && kind !== 'teacher') throw new Error('找回链接类型无效')
  const url = new URL(inviteLink(base, event))
  url.searchParams.set(REIDENTIFY_PARAM, kind)
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (validReidentifyAlias(trimmed)) url.searchParams.set(NAME_PARAM, trimmed)
  return url.href
}

/** 解析换机找回链接；普通邀请链接返回 null（由既有邀请流程处理）。 */
export function readReidentifyLink(link: string): { event: Event; kind: ReidentifyLinkKind; name: string } | null {
  let url: URL
  try { url = new URL(link) } catch { return null }
  const kind = url.searchParams.get(REIDENTIFY_PARAM)
  if (kind !== 'student' && kind !== 'teacher') return null
  let event: Event | null
  try { event = readInviteLink(link) } catch { return null }
  if (!event) return null
  const rawName = url.searchParams.get(NAME_PARAM) ?? ''
  const name = validReidentifyAlias(rawName) ? rawName.trim() : ''
  return { event, kind, name }
}
