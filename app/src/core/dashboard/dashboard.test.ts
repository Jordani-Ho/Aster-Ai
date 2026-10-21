import { describe, expect, it } from 'vitest'
import { dashboardConfig, dashboardKeyFromHash } from './config'
import { errorTotal, groupStats, normalizeStats, statsFromEnvelope } from './dashboard'
import { statsEnvelope, type DailyStats } from './types'

// V2-14 仪表盘只读数据：白名单字段、最近 30 天、私钥只从本地 hash/session 来。
const STATS: DailyStats = {
  version: 1,
  appVersion: '0.0.1',
  hallId: 'a'.repeat(16),
  date: '2026-10-20',
  onlineSeconds: 120,
  errorCounts: { uncaughtError: 1, unhandledRejection: 0 },
  consults: 2,
  signatures: 1,
  avgSignMinutes: 12.5,
  homeworkCheckins: 3,
  tongueRecords: 1,
  students: 2,
}

describe('统计载荷白名单', () => {
  it('只接受规定字段与类型，多余字段整条丢弃', () => {
    expect(normalizeStats(STATS)).toEqual(STATS)
    expect(normalizeStats({ ...STATS, note: '不许出现' })).toBeNull()
    expect(normalizeStats({ ...STATS, hallId: 'b'.repeat(64) })).toBeNull()
    expect(normalizeStats({ ...STATS, avgSignMinutes: 0 })).toMatchObject({ avgSignMinutes: 0 })
    expect(normalizeStats({ ...STATS, avgSignMinutes: null })).toMatchObject({ avgSignMinutes: null })
    expect(normalizeStats({ ...STATS, homeworkCheckins: null })).toMatchObject({ homeworkCheckins: null })
    expect(normalizeStats({ ...STATS, errorCounts: { uncaughtError: 1 } })).toBeNull()
    expect(normalizeStats({ ...STATS, consults: -1 })).toBeNull()
    expect(normalizeStats({ ...STATS, appVersion: 'x'.repeat(41) })).toBeNull()
  })

  it('信封类型/版本不对就不认', () => {
    expect(statsFromEnvelope(statsEnvelope(STATS))).toEqual(STATS)
    expect(statsFromEnvelope({ type: 'other', version: 1, payload: STATS })).toBeNull()
    expect(statsFromEnvelope({ type: 'community.stats', version: 2, payload: STATS } as never)).toBeNull()
  })

  it('错误按类型合计', () => {
    expect(errorTotal(STATS)).toBe(1)
  })
})

describe('最近 30 天按馆分组', () => {
  it('过滤过期、同馆同日去重、按日期倒序', () => {
    const recent = { ...STATS, date: '2026-10-18' }
    const old = { ...STATS, hallId: 'b'.repeat(16), date: '2026-09-01' }
    const other = { ...STATS, hallId: 'c'.repeat(16), date: '2026-10-20', consults: 9 }
    const groups = groupStats([STATS, recent, { ...STATS, consults: 7 }, old, other], '2026-10-20')
    expect(groups).toHaveLength(2)
    const a = groups.find(group => group.hallId === STATS.hallId)!
    expect(a.days.map(day => day.date)).toEqual(['2026-10-20', '2026-10-18'])
    expect(a.days[0].consults).toBe(2)
    expect(groups.find(group => group.hallId === 'c'.repeat(16))!.days).toHaveLength(1)
    expect(groups.some(group => group.hallId === 'b'.repeat(16))).toBe(false)
  })
})

describe('仪表盘配置与钥匙', () => {
  it('公钥和地址都填了才发送', () => {
    expect(dashboardConfig({})).toMatchObject({ configured: false, pubkey: '', url: '' })
    expect(dashboardConfig({ VITE_DASHBOARD_PUBKEY: 'e'.repeat(64), VITE_DASHBOARD_URL: '' }).configured).toBe(false)
    expect(dashboardConfig({ VITE_DASHBOARD_PUBKEY: 'bad', VITE_DASHBOARD_URL: 'https://x/#dashboard' }).configured).toBe(false)
    expect(dashboardConfig({ VITE_DASHBOARD_PUBKEY: 'E'.repeat(64), VITE_DASHBOARD_URL: 'https://x/#dashboard' })).toMatchObject({ configured: true, pubkey: 'e'.repeat(64), url: 'https://x/#dashboard' })
  })

  it('只从 URL hash 读解密钥匙', () => {
    expect(dashboardKeyFromHash('#dashboard=' + 'f'.repeat(64))).toBe('f'.repeat(64))
    expect(dashboardKeyFromHash('#dashboard-key=' + 'a'.repeat(64))).toBe('a'.repeat(64))
    expect(dashboardKeyFromHash('#dashboard=' + 'a'.repeat(63))).toBeNull()
    expect(dashboardKeyFromHash('#other=' + 'a'.repeat(64))).toBeNull()
    expect(dashboardKeyFromHash('')).toBeNull()
  })
})
