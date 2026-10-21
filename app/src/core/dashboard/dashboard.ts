import type { Envelope } from '../transport/crypto'
import { STATS_ENVELOPE_TYPE, STATS_SCHEMA_VERSION, type DailyStats } from './types'

// V2-14 只读仪表盘：只接受白名单字段、精确类型；多余字段整条丢弃。
const HEX16 = /^[0-9a-f]{16}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ALLOWED = new Set([
  'version', 'appVersion', 'hallId', 'date', 'onlineSeconds', 'errorCounts',
  'consults', 'signatures', 'avgSignMinutes', 'homeworkCheckins', 'tongueRecords', 'students',
])

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function normalizeStats(value: unknown): DailyStats | null {
  if (!object(value)) return null
  if (Object.keys(value).some(key => !ALLOWED.has(key))) return null
  if (value.version !== STATS_SCHEMA_VERSION) return null
  if (typeof value.appVersion !== 'string' || value.appVersion.length > 40) return null
  if (typeof value.hallId !== 'string' || !HEX16.test(value.hallId)) return null
  if (typeof value.date !== 'string' || !DATE.test(value.date)) return null
  if (!count(value.onlineSeconds) || !count(value.consults) || !count(value.signatures)) return null
  if (!count(value.tongueRecords) || !count(value.students)) return null
  if (value.avgSignMinutes !== null && (typeof value.avgSignMinutes !== 'number' || !Number.isFinite(value.avgSignMinutes) || value.avgSignMinutes < 0)) return null
  if (value.homeworkCheckins !== null && !count(value.homeworkCheckins)) return null
  if (!object(value.errorCounts)) return null
  const errors = value.errorCounts
  if (Object.keys(errors).some(key => key !== 'uncaughtError' && key !== 'unhandledRejection')) return null
  if (!count(errors.uncaughtError) || !count(errors.unhandledRejection)) return null
  return {
    version: STATS_SCHEMA_VERSION,
    appVersion: value.appVersion,
    hallId: value.hallId,
    date: value.date,
    onlineSeconds: value.onlineSeconds,
    errorCounts: { uncaughtError: errors.uncaughtError, unhandledRejection: errors.unhandledRejection },
    consults: value.consults,
    signatures: value.signatures,
    avgSignMinutes: value.avgSignMinutes,
    homeworkCheckins: value.homeworkCheckins,
    tongueRecords: value.tongueRecords,
    students: value.students,
  }
}

export function statsFromEnvelope(envelope: Envelope): DailyStats | null {
  if (envelope.type !== STATS_ENVELOPE_TYPE || envelope.version !== 1) return null
  return normalizeStats(envelope.payload)
}

export interface HallStats {
  hallId: string
  days: DailyStats[]
}

/** 最近 N 天（默认 30，含今天）按馆分组，日期新的在前。 */
export function groupStats(records: readonly DailyStats[], today: string, days = 30): HallStats[] {
  const start = new Date(today + 'T00:00:00Z').getTime() - (days - 1) * 86400000
  const byHall = new Map<string, DailyStats[]>()
  for (const record of records) {
    const at = Date.parse(record.date + 'T00:00:00Z')
    if (!Number.isFinite(at) || at < start || at > new Date(today + 'T00:00:00Z').getTime()) continue
    const list = byHall.get(record.hallId) ?? []
    if (!list.some(item => item.date === record.date)) list.push(record)
    byHall.set(record.hallId, list)
  }
  return [...byHall.entries()]
    .map(([hallId, list]) => ({ hallId, days: list.sort((a, b) => b.date.localeCompare(a.date)) }))
    .sort((a, b) => a.hallId.localeCompare(b.hallId))
}

export function errorTotal(record: DailyStats): number {
  return record.errorCounts.uncaughtError + record.errorCounts.unhandledRejection
}
