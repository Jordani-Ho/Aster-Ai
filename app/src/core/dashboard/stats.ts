import type { LocalStore, StoreValue } from '../store'
import { listConsults, type StoredConsult } from '../inbox'
import { teacherStudents } from '../records/teacher'
import { localDay } from '../homework/schedule'
import type { Envelope } from '../transport/crypto'
import { currentOnlineSeconds } from './session'
import { loadErrorCounts } from './errors'
import {
  APP_VERSION, STATS_SCHEMA_VERSION, statsEnvelope,
  type DailyStats, type ErrorCounts,
} from './types'

// V2-14：统计只从本机已有集合数数，不读内容，不读学生本人感受（kangbi-self 永远不在这里）。
export const SHARE_SETTING = 'dashboard-share'
export const HALL_ID_SETTING = 'dashboard-hall-id'
export const LAST_SENT_SETTING = 'dashboard-last-sent'
const HEX64 = /^[0-9a-f]{64}$/
const HEX16 = /^[0-9a-f]{16}$/

export async function loadStatsShare(store: Pick<LocalStore, 'get'>): Promise<boolean> {
  const value = await store.get('settings', SHARE_SETTING) as { enabled?: unknown } | undefined
  return value?.enabled !== false
}

export async function saveStatsShare(store: Pick<LocalStore, 'put'>, enabled: boolean): Promise<void> {
  await store.put('settings', SHARE_SETTING, { enabled } as unknown as StoreValue)
}

/** 本馆随机 ID（16 位十六进制），不是公钥、不是名字；仪表盘只靠它区分馆。 */
export async function loadHallId(store: Pick<LocalStore, 'get' | 'put'>): Promise<string> {
  const stored = await store.get('settings', HALL_ID_SETTING)
  if (typeof stored === 'string' && HEX16.test(stored)) return stored
  const next = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  await store.put('settings', HALL_ID_SETTING, next)
  return next
}

function isoDay(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? localDay(new Date(at)) : null
}

function todayConsults(consults: StoredConsult[], day: string): StoredConsult[] {
  return consults.filter(consult => isoDay(consult.receivedAt) === day)
}

function signedRecordsToday(rows: { value: unknown }[], day: string): { encounterId: string; createdAt: number }[] {
  const result: { encounterId: string; createdAt: number }[] = []
  for (const row of rows) {
    if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) continue
    const value = row.value as Record<string, unknown>
    if (typeof value.encounterId !== 'string') continue
    const at = typeof value.createdAt === 'string' ? Date.parse(value.createdAt) : NaN
    if (!Number.isFinite(at) || localDay(new Date(at)) !== day) continue
    result.push({ encounterId: value.encounterId, createdAt: at })
  }
  return result
}

function averageSignMinutes(signed: { encounterId: string; createdAt: number }[], consults: StoredConsult[]): number | null {
  const byId = new Map(consults.map(consult => [consult.encounter.id, consult]))
  const durations: number[] = []
  for (const record of signed) {
    const consult = byId.get(record.encounterId)
    if (!consult) continue
    const receivedAt = Date.parse(consult.receivedAt)
    if (!Number.isFinite(receivedAt)) continue
    durations.push(Math.max(0, (record.createdAt - receivedAt) / 60000))
  }
  if (durations.length === 0) return null
  return Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10
}

function checkinsToday(consultsToday: StoredConsult[], day: string): number | null {
  const latestByStudent = new Map<string, StoredConsult>()
  for (const consult of consultsToday) {
    const key = consult.sender
    const prior = latestByStudent.get(key)
    if (!prior || Date.parse(consult.receivedAt) > Date.parse(prior.receivedAt)) latestByStudent.set(key, consult)
  }
  let total = 0
  let found = false
  for (const consult of latestByStudent.values()) {
    const trend = consult.trend
    if (!trend) continue
    const index = trend.days.indexOf(day)
    if (index < 0) continue
    const value = trend.checkins[index]
    if (!Number.isSafeInteger(value) || value < 0) continue
    total += value
    found = true
  }
  return found ? total : null
}

export interface BuildDailyStatsOptions {
  now?: Date
  /** 测试固定本馆 ID；正式运行时从本机设置里生成一次。 */
  hallId?: string
  /** 测试固定在线秒数；不传时按本机会话累计。 */
  onlineSeconds?: number
  errorCounts?: Partial<ErrorCounts>
}

/** 只数本机已有集合的条数/次数；不读病历字段内容、不读钱账、不读学生本人感受。 */
export async function buildDailyStats(store: LocalStore, options: BuildDailyStatsOptions = {}): Promise<DailyStats> {
  const now = options.now ?? new Date()
  const day = localDay(now)
  const consults = await listConsults(store)
  const consultsToday = todayConsults(consults, day)
  const signed = signedRecordsToday(await store.list('teacher-records'), day)
  const errorCounts = { ...(await loadErrorCounts(store, now)), ...(options.errorCounts ?? {}) }
  const onlineSeconds = options.onlineSeconds ?? await currentOnlineSeconds(store, now.getTime())
  const hallId = options.hallId && HEX16.test(options.hallId) ? options.hallId : await loadHallId(store)
  return {
    version: STATS_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    hallId,
    date: day,
    onlineSeconds: Math.max(0, Math.floor(onlineSeconds)),
    errorCounts,
    consults: consultsToday.length,
    signatures: signed.length,
    avgSignMinutes: averageSignMinutes(signed, consults),
    homeworkCheckins: checkinsToday(consultsToday, day),
    tongueRecords: consultsToday.reduce((sum, consult) => sum + (consult.encounter.intake.tongues?.length ?? 0), 0),
    students: (await teacherStudents(store)).length,
  }
}

export interface SendDailyStatsOptions {
  store: LocalStore
  send: (recipient: string, envelope: Envelope) => Promise<unknown>
  dashboardPubkey: string
  dashboardUrl: string
  now?: Date
}

export interface SendDailyStatsResult {
  sent: boolean
  reason?: 'disabled' | 'no-dashboard' | 'already-sent'
  stats?: DailyStats
}

/** 打开应用时调用：开关开、配置了仪表盘、今天还没发过，才发一条；成功后记下日期。 */
export async function sendDailyStats(options: SendDailyStatsOptions): Promise<SendDailyStatsResult> {
  const { store, send, now = new Date() } = options
  if (!HEX64.test(options.dashboardPubkey) || options.dashboardUrl.trim() === '') return { sent: false, reason: 'no-dashboard' }
  if (!await loadStatsShare(store)) return { sent: false, reason: 'disabled' }
  const day = localDay(now)
  const last = await store.get('settings', LAST_SENT_SETTING)
  if (last === day) return { sent: false, reason: 'already-sent' }
  const stats = await buildDailyStats(store, { now })
  await send(options.dashboardPubkey, statsEnvelope(stats))
  await store.put('settings', LAST_SENT_SETTING, day)
  return { sent: true, stats }
}

export function statsEnvelopeFor(stats: DailyStats): Envelope {
  return statsEnvelope(stats)
}
