import type { Identity } from '../identity'
import type { LocalStore, StoreValue } from '../store'
import { makeInvite } from '../onboarding'
import { loadOwnStorefront } from '../storefront'
import { storefrontInviteLink } from '../storefront/invite'
import { teacherStudents } from '../records/teacher'

// V2-15 建馆：开馆是本机状态 + 门面签发，不新增服务器接口。
// 引导进度只存在本机 settings；第一位学生的邀请沿用现有签名邀请，1 小时只是参数。
export const HALL_SETTING = 'hall'
export const OPENING_GUIDE_SETTING = 'opening-guide'
export const FIRST_INVITE_SECONDS = 3600

export type GuideStep = 1 | 2 | 3 | 4 | 5

export interface HallState {
  openedAt: string
  completedAt: string | null
}

export interface GuideInvite {
  link: string
  createdAt: number
  expiresAt: number
}

export interface GuideState {
  step: GuideStep
  firstInvite: GuideInvite | null
}

const STEPS: readonly number[] = [1, 2, 3, 4, 5]
// 老部署没有开馆标记：已有门面、学生或收到过问诊，就按已开馆处理（升级不重走引导）。
const OPENED_PROBES = ['teacher-students', 'teacher-records', 'consult-package', 'student-adherence', 'ledger-index'] as const

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

export function normalizeGuide(value: unknown): GuideState {
  if (!object(value)) return { step: 1, firstInvite: null }
  const step = typeof value.step === 'number' && STEPS.includes(value.step) ? value.step as GuideStep : 1
  const raw = value.firstInvite
  const createdAt = object(raw) ? raw.createdAt : undefined
  const expiresAt = object(raw) ? raw.expiresAt : undefined
  const firstInvite = object(raw)
    && typeof raw.link === 'string' && raw.link.length <= 20000
    && Number.isSafeInteger(createdAt) && Number.isSafeInteger(expiresAt)
    && (expiresAt as number) > (createdAt as number)
    ? { link: raw.link, createdAt: createdAt as number, expiresAt: expiresAt as number }
    : null
  return { step, firstInvite }
}

export async function loadGuide(store: Pick<LocalStore, 'get'>): Promise<GuideState> {
  return normalizeGuide(await store.get('settings', OPENING_GUIDE_SETTING))
}

export async function saveGuide(store: Pick<LocalStore, 'put'>, guide: GuideState): Promise<GuideState> {
  const clean = normalizeGuide(guide)
  await store.put('settings', OPENING_GUIDE_SETTING, clean as unknown as StoreValue)
  return clean
}

export async function loadHall(store: Pick<LocalStore, 'get'>): Promise<HallState | null> {
  const value = await store.get('settings', HALL_SETTING)
  if (!object(value)) return null
  const openedAt = iso(value.openedAt)
  if (!openedAt) return null
  return { openedAt, completedAt: iso(value.completedAt) }
}

export async function hasOpenedHall(store: Pick<LocalStore, 'get' | 'list'>, identity: Identity): Promise<boolean> {
  if (await loadHall(store)) return true
  const own = await loadOwnStorefront(store, identity)
  if (own.current) return true
  for (const collection of OPENED_PROBES) if ((await store.list(collection)).length > 0) return true
  return false
}

export async function markHallOpened(store: Pick<LocalStore, 'get' | 'put'>, now = Date.now()): Promise<HallState> {
  const prior = await loadHall(store)
  const next: HallState = { openedAt: prior?.openedAt ?? new Date(now).toISOString(), completedAt: prior?.completedAt ?? null }
  await store.put('settings', HALL_SETTING, next as unknown as StoreValue)
  return next
}

export async function completeHall(store: Pick<LocalStore, 'get' | 'put'>, now = Date.now()): Promise<HallState> {
  const opened = await markHallOpened(store, now)
  const next: HallState = { openedAt: opened.openedAt, completedAt: opened.completedAt ?? new Date(now).toISOString() }
  await store.put('settings', HALL_SETTING, next as unknown as StoreValue)
  return next
}

/** 第一位学生加入后老师才知道：学生连上社区会发坚持率小结，老师端据此认得他。 */
export async function hasFirstStudent(store: Pick<LocalStore, 'list'>): Promise<boolean> {
  return (await teacherStudents(store)).length > 0
}

export interface CreateFirstInviteOptions {
  identity: Identity
  store: Pick<LocalStore, 'get'>
  base: string
  gateway: string
  now?: number
}

/** 开馆后立刻给第一位学生生成 1 小时内有效的邀请，并带上刚签发的门面。 */
export async function createFirstInvite(options: CreateFirstInviteOptions): Promise<GuideInvite> {
  const { identity, store, base, gateway } = options
  const now = options.now ?? Date.now()
  if (gateway === '') throw new Error('还没有配置社区网关，暂时不能生成邀请。')
  const invite = makeInvite(identity, gateway + '/invite/redeem', Math.floor(now / 1000), FIRST_INVITE_SECONDS)
  const own = await loadOwnStorefront(store, identity)
  return {
    link: storefrontInviteLink(base, invite, own.current),
    createdAt: now,
    expiresAt: now + FIRST_INVITE_SECONDS * 1000,
  }
}

export function guideInviteExpired(invite: Pick<GuideInvite, 'expiresAt'>, now = Date.now()): boolean {
  return now >= invite.expiresAt
}
