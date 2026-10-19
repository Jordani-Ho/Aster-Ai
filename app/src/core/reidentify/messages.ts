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
/** V2-07b：管理人新身份 → 老师（家人认回清单）；老师 → 管理人（匹配结果/候选）。 */
export const REIDENTIFY_FAMILY = 'reidentify.family'
export const MAX_FAMILY_CLAIMS = 8
/** 管理人本机记的家人认回结果，键为新家人公钥。 */
export const FAMILY_REIDENTIFY_RESULTS = 'family-reidentify'
/** 老师端待确认的换机请求，键为新学生公钥。 */
export const REIDENTIFY_REQUESTS = 'reidentify-requests'
/** 学生端收到的“老师没确认”通知时间；只做提示，不改名单与记录。 */
export const REIDENTIFY_REJECTED_SETTING = 'reidentify-rejected'
/** 老师生成“老师换手机”链接时记的时间；只有生成后 30 天内才接受 teacher 类确认。 */
export const TEACHER_REIDENTIFY_OPEN_SETTING = 'teacher-reidentify-open'
export const TEACHER_REIDENTIFY_WINDOW_DAYS = 30
/** 老师端按发件人记住已接受的 teacher 类确认，防止同一人反复改映射。 */
export const TEACHER_CONFIRMS = 'reidentify-teacher-confirms'

export type ReidentifyPurpose = 'student' | 'teacher'
export type ReidentifyLinkKind = ReidentifyPurpose

export interface PendingReidentifyRequest { student: string; alias: string; receivedAt: string }

const HEX64 = /^[0-9a-f]{64}$/
const MAX_ALIAS = 12
const DAY = 86400000

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

// 老师生成“老师换手机”链接时写标记；只有刚换手机的老师才会接受学生发来的 teacher 类确认。
export async function openTeacherReidentify(store: Pick<LocalStore, 'put'>, at = new Date()): Promise<void> {
  await store.put('settings', TEACHER_REIDENTIFY_OPEN_SETTING, at.toISOString() as unknown as StoreValue)
}

export async function teacherReidentifyOpenAt(store: Pick<LocalStore, 'get'>): Promise<string | null> {
  const value = await store.get('settings', TEACHER_REIDENTIFY_OPEN_SETTING)
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

/** 标记存在且未超过 30 天才算有效（时间可注入，测试不依赖真实时钟）。 */
export function teacherReidentifyWindowOpen(openedAt: string | null, now = new Date()): boolean {
  if (typeof openedAt !== 'string' || !Number.isFinite(Date.parse(openedAt))) return false
  const age = now.getTime() - Date.parse(openedAt)
  return age >= 0 && age <= TEACHER_REIDENTIFY_WINDOW_DAYS * DAY
}

export interface TeacherConfirmRecord { student: string; oldKey: string; at: string }

/** 同一发件人只认第一次的旧老师公钥；第二次带不同旧公钥一律不认。 */
export async function loadTeacherConfirm(store: Pick<LocalStore, 'get'>, student: string): Promise<TeacherConfirmRecord | null> {
  if (!HEX64.test(student)) return null
  const value = await store.get(TEACHER_CONFIRMS, student) as Partial<TeacherConfirmRecord> | undefined
  if (!value || typeof value !== 'object') return null
  if (value.student !== student || typeof value.oldKey !== 'string' || !HEX64.test(value.oldKey)) return null
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null
  return { student, oldKey: value.oldKey, at: value.at }
}

export async function saveTeacherConfirm(store: Pick<LocalStore, 'put'>, student: string, oldKey: string, at = new Date()): Promise<TeacherConfirmRecord> {
  if (!HEX64.test(student) || !HEX64.test(oldKey)) throw new Error('换机确认公钥无效')
  const record: TeacherConfirmRecord = { student, oldKey, at: at.toISOString() }
  await store.put(TEACHER_CONFIRMS, student, record as unknown as StoreValue)
  return record
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

// ---- V2-07b：家人随管理人一起认回 ----
// reidentify.family 双向：管理人发 claim（重新添加的家人 alias + 新公钥，可带手动选择的旧公钥）；
// 老师回 result（已匹配 / 未匹配 + 该旧管理人名下的旧家人候选）。老师端不逐个点“是”。
export interface FamilyClaim { alias: string; newKey: string; oldKey?: string }
export interface FamilyCandidate { oldKey: string; alias: string }
export interface FamilyMatched { newKey: string; oldKey: string; alias: string }
export interface FamilyUnresolved { newKey: string; alias: string; candidates: FamilyCandidate[] }

export function familyClaimEnvelope(families: readonly FamilyClaim[]): Envelope {
  if (!Array.isArray(families) || families.length === 0 || families.length > MAX_FAMILY_CLAIMS) throw new Error('家人认回清单无效')
  const clean = families.map(family => {
    if (!family || !validReidentifyAlias(family.alias) || !HEX64.test(family.newKey)) throw new Error('家人认回清单无效')
    const item: FamilyClaim = { alias: family.alias.trim(), newKey: family.newKey }
    if (family.oldKey !== undefined) {
      if (!HEX64.test(family.oldKey) || family.oldKey === family.newKey) throw new Error('家人认回清单无效')
      item.oldKey = family.oldKey
    }
    return item
  })
  return { type: REIDENTIFY_FAMILY, version: 1, payload: { action: 'claim', families: clean } }
}

export function parseFamilyClaim(payload: unknown): { families: FamilyClaim[] } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const v = payload as { action?: unknown; families?: unknown }
  if (v.action !== 'claim' || !Array.isArray(v.families) || v.families.length === 0 || v.families.length > MAX_FAMILY_CLAIMS) return null
  const families: FamilyClaim[] = []
  for (const raw of v.families) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const item = raw as { alias?: unknown; newKey?: unknown; oldKey?: unknown }
    if (!validReidentifyAlias(item.alias) || typeof item.newKey !== 'string' || !HEX64.test(item.newKey)) return null
    if (item.oldKey !== undefined && (typeof item.oldKey !== 'string' || !HEX64.test(item.oldKey) || item.oldKey === item.newKey)) return null
    families.push({ alias: item.alias.trim(), newKey: item.newKey, ...(item.oldKey === undefined ? {} : { oldKey: item.oldKey }) })
  }
  return { families }
}

export function familyResultEnvelope(matched: readonly FamilyMatched[], unresolved: readonly FamilyUnresolved[]): Envelope {
  return { type: REIDENTIFY_FAMILY, version: 1, payload: { action: 'result', matched: [...matched], unresolved: [...unresolved] } }
}

export function parseFamilyResult(payload: unknown): { matched: FamilyMatched[]; unresolved: FamilyUnresolved[] } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const v = payload as { action?: unknown; matched?: unknown; unresolved?: unknown }
  if (v.action !== 'result' || !Array.isArray(v.matched) || !Array.isArray(v.unresolved)) return null
  const matched: FamilyMatched[] = []
  for (const raw of v.matched) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const item = raw as { newKey?: unknown; oldKey?: unknown; alias?: unknown }
    if (typeof item.newKey !== 'string' || !HEX64.test(item.newKey) || typeof item.oldKey !== 'string' || !HEX64.test(item.oldKey) || !validReidentifyAlias(item.alias)) return null
    matched.push({ newKey: item.newKey, oldKey: item.oldKey, alias: item.alias.trim() })
  }
  const unresolved: FamilyUnresolved[] = []
  for (const raw of v.unresolved) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const item = raw as { newKey?: unknown; alias?: unknown; candidates?: unknown }
    if (typeof item.newKey !== 'string' || !HEX64.test(item.newKey) || !validReidentifyAlias(item.alias) || !Array.isArray(item.candidates)) return null
    const candidates: FamilyCandidate[] = []
    for (const candidate of item.candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
      const value = candidate as { oldKey?: unknown; alias?: unknown }
      if (typeof value.oldKey !== 'string' || !HEX64.test(value.oldKey) || !validReidentifyAlias(value.alias)) return null
      candidates.push({ oldKey: value.oldKey, alias: value.alias.trim() })
    }
    unresolved.push({ newKey: item.newKey, alias: item.alias.trim(), candidates })
  }
  return { matched, unresolved }
}

export interface FamilyResultRow {
  newKey: string
  alias: string
  status: 'matched' | 'unresolved'
  oldKey?: string
  chosenOldKey?: string
  candidates: FamilyCandidate[]
  updatedAt: string
}

export async function saveFamilyResult(store: Pick<LocalStore, 'put'>, row: Omit<FamilyResultRow, 'updatedAt'>, at = new Date()): Promise<void> {
  if (!HEX64.test(row.newKey)) throw new Error('家人公钥无效')
  const value: FamilyResultRow = { ...row, candidates: row.candidates.slice(0, MAX_FAMILY_CLAIMS), updatedAt: at.toISOString() }
  await store.put(FAMILY_REIDENTIFY_RESULTS, row.newKey, value as unknown as StoreValue)
}

export async function listFamilyResults(store: Pick<LocalStore, 'list'>): Promise<FamilyResultRow[]> {
  const result: FamilyResultRow[] = []
  for (const row of await store.list(FAMILY_REIDENTIFY_RESULTS)) {
    const value = row.value as Partial<FamilyResultRow> | undefined
    if (!value || typeof value !== 'object' || value.newKey !== row.key) continue
    if (!HEX64.test(value.newKey) || !validReidentifyAlias(value.alias)) continue
    if (value.status !== 'matched' && value.status !== 'unresolved') continue
    const candidates: FamilyCandidate[] = []
    if (Array.isArray(value.candidates)) for (const item of value.candidates) {
      if (item && typeof item === 'object' && typeof item.oldKey === 'string' && HEX64.test(item.oldKey) && validReidentifyAlias(item.alias)) candidates.push({ oldKey: item.oldKey, alias: item.alias.trim() })
    }
    result.push({
      newKey: value.newKey, alias: value.alias.trim(), status: value.status,
      ...(typeof value.oldKey === 'string' && HEX64.test(value.oldKey) ? { oldKey: value.oldKey } : {}),
      ...(typeof value.chosenOldKey === 'string' && HEX64.test(value.chosenOldKey) ? { chosenOldKey: value.chosenOldKey } : {}),
      candidates,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    })
  }
  return result
}

/** 管理人手动选一位旧家人对上；下次 claim 会带上这个 oldKey。 */
export async function chooseFamilyOldKey(store: Pick<LocalStore, 'list' | 'put'>, newKey: string, oldKey: string): Promise<void> {
  const rows = await listFamilyResults(store)
  const row = rows.find(item => item.newKey === newKey)
  if (!row || !HEX64.test(oldKey)) throw new Error('没有这条家人认回记录')
  if (!row.candidates.some(candidate => candidate.oldKey === oldKey)) throw new Error('请从候选里选择一位旧家人')
  await saveFamilyResult(store, { ...row, chosenOldKey: oldKey } as Omit<FamilyResultRow, 'updatedAt'>)
}

