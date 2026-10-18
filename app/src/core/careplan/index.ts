import { finalizeEvent, getEventHash, verifyEvent } from 'nostr-tools/pure'
import type { Envelope } from '../transport'
import type { LocalStore, StoreValue } from '../store'

// 老师给学生定制调养方案：签字事件 kind 2731，content 是 CarePlan JSON，
// 经中继信封 care.plan 发送；学生端只接受“我的老师”名单里签发的，新版本替换旧版本。
// 签名/验签路径不引入任何模型调用（同 record/sign 的约定）。
export const CARE_PLAN_KIND = 2731
export const CARE_PLAN_TYPE = 'care.plan'
export const CARE_PLAN_COLLECTION = 'care-plans'

const HEX64 = /^[0-9a-f]{64}$/

export interface CarePlan {
  constitution: string   // 体质（文字）
  points: string[]       // 调养要点
  avoid: string[]        // 忌口与忌做
  updatedAt: string      // ISO 8601
  version: number        // 1, 2, 3…… 新版本替换旧版本
}

export interface SignedCarePlanEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

function isTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '')
}

export function isValidCarePlan(value: unknown): value is CarePlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const plan = value as Record<string, unknown>
  if (typeof plan.constitution !== 'string' || plan.constitution.trim() === '') return false
  if (!isTextArray(plan.points) || !isTextArray(plan.avoid)) return false
  if (typeof plan.updatedAt !== 'string' || !Number.isFinite(Date.parse(plan.updatedAt))) return false
  if (!Number.isSafeInteger(plan.version) || (plan.version as number) < 1) return false
  return true
}

export function signCarePlan(plan: CarePlan, student: string, privateKey: Uint8Array): SignedCarePlanEvent {
  if (!isValidCarePlan(plan)) throw new Error('调养方案结构无效')
  if (!HEX64.test(student)) throw new Error('学生公钥无效')
  const event = finalizeEvent({
    kind: CARE_PLAN_KIND,
    created_at: Math.floor(Date.parse(plan.updatedAt) / 1000),
    tags: [['p', student]],
    content: JSON.stringify(plan),
  }, privateKey)
  // E-004/E-005：JSON 往返去掉 verify 缓存 Symbol，签名事件才能安全落盘/进信封。
  return JSON.parse(JSON.stringify(event)) as SignedCarePlanEvent
}

export function verifySignedCarePlan(event: SignedCarePlanEvent, options: { student: string; teacher: string }): CarePlan {
  if (!event || typeof event !== 'object') throw new Error('签名调养方案格式无效')
  if (event.kind !== CARE_PLAN_KIND) throw new Error('不是调养方案事件')
  // 先重算 id，确认 content 与 id 绑定，再验签（见 team/mistakes E-004）。
  let idMatches = false
  try { idMatches = getEventHash(event) === event.id } catch { idMatches = false }
  if (!idMatches) throw new Error('调养方案内容与事件 id 不一致，可能被篡改')
  if (!verifyEvent(event)) throw new Error('签名校验失败')
  let plan: unknown
  try { plan = JSON.parse(event.content) } catch { throw new Error('调养方案内容不是合法 JSON') }
  if (!isValidCarePlan(plan)) throw new Error('调养方案内容无效')
  if (event.pubkey !== options.teacher) throw new Error('签名人不是这位学生的老师')
  const pTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === 'p')?.[1]
  if (pTag !== options.student) throw new Error('p 标签不是当前学生')
  return plan
}

export function parseSignedCarePlanEvent(value: unknown): SignedCarePlanEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !HEX64.test(v.id)) return null
  if (typeof v.pubkey !== 'string' || !HEX64.test(v.pubkey)) return null
  if (typeof v.sig !== 'string' || typeof v.content !== 'string') return null
  if (!Number.isSafeInteger(v.created_at) || v.kind !== CARE_PLAN_KIND || !Array.isArray(v.tags)) return null
  const tags = v.tags.filter((tag): tag is string[] => Array.isArray(tag) && tag.every(item => typeof item === 'string'))
  if (tags.length !== v.tags.length) return null
  return { id: v.id, pubkey: v.pubkey, created_at: v.created_at as number, kind: CARE_PLAN_KIND, tags, content: v.content, sig: v.sig }
}

export function carePlanEnvelope(event: SignedCarePlanEvent): Envelope {
  return { type: CARE_PLAN_TYPE, version: 1, payload: event }
}

export async function sendCarePlan(send: (recipient: string, envelope: Envelope) => Promise<unknown>, student: string, event: SignedCarePlanEvent): Promise<void> {
  await send(student, carePlanEnvelope(event))
}

// 学生端入库：按老师公钥为键，只接受更新的版本；旧版/同版迟到不覆盖。返回是否写入。
export async function storeCarePlan(store: LocalStore, teacher: string, plan: CarePlan): Promise<boolean> {
  const existing = await store.get(CARE_PLAN_COLLECTION, teacher) as unknown as CarePlan | undefined
  if (existing && existing.version >= plan.version) return false
  await store.put(CARE_PLAN_COLLECTION, teacher, plan as unknown as StoreValue)
  return true
}

export async function currentCarePlan(store: LocalStore, teacher: string): Promise<CarePlan | null> {
  const value = await store.get(CARE_PLAN_COLLECTION, teacher)
  return isValidCarePlan(value) ? value : null
}

export async function listCarePlans(store: LocalStore): Promise<{ teacher: string; plan: CarePlan }[]> {
  const rows = await store.list(CARE_PLAN_COLLECTION)
  const result: { teacher: string; plan: CarePlan }[] = []
  for (const row of rows) {
    if (typeof row.key !== 'string' || !HEX64.test(row.key) || !isValidCarePlan(row.value)) continue
    result.push({ teacher: row.key, plan: row.value })
  }
  return result
}
