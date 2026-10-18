import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import type { LlmClient } from '../llm'
import type { CarePlan } from '../careplan'
import { dailyMirror, getDailyMirror } from './index'
import { last14DayTrend, recordSelfRating, recordStressRating, listSelfRatings, listStressRatings, stressHighStreak, validScore } from './trend'

// 小药名表：验收第 2 条用它断言建议里不出现任何药名。
const MEDICINES = ['黄芪', '当归', '人参', '白术', '茯苓', '甘草', '川芎', '白芍', '附子', '麻黄', '桂枝', '柴胡', '丹参', '三七', '枸杞']

const carePlan: CarePlan = {
  constitution: '平和质',
  points: ['早睡早起', '饭后散步'],
  avoid: ['生冷', '熬夜'],
  updatedAt: '2026-10-17T08:00:00.000Z',
  version: 1,
}

const now = new Date('2026-10-17T09:00:00.000Z')

function llmReturning(reply: unknown): LlmClient {
  return { complete: vi.fn().mockResolvedValue(typeof reply === 'string' ? reply : JSON.stringify(reply)), stream: vi.fn() }
}
function llmThrowing(): LlmClient {
  return { complete: vi.fn().mockRejectedValue(new Error('network down')), stream: vi.fn() }
}

function assertNoMedicine(result: { greeting: string; today: string[] }) {
  const text = [result.greeting, ...result.today].join('')
  for (const name of MEDICINES) expect(text).not.toContain(name)
}

function assertNoPreaching(today: string[]) {
  for (const line of today) {
    expect(line.startsWith('不要')).toBe(false)
    expect(line.startsWith('禁止')).toBe(false)
    expect(line.startsWith('不许')).toBe(false)
  }
}

describe('dailyMirror 回退与药名（验收第 2、4 条）', () => {
  it('没有调养方案时用节气养生给出非空建议，且无药名', async () => {
    const result = await dailyMirror({ carePlan: null, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [], now: () => now })
    expect(result.today.length).toBeGreaterThan(0)
    assertNoMedicine(result)
    assertNoPreaching(result.today)
  })

  it('断网时回退，建议非空且无药名', async () => {
    const result = await dailyMirror({ carePlan, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [], llm: llmThrowing(), now: () => now })
    expect(result.today.length).toBeGreaterThan(0)
    assertNoMedicine(result)
    assertNoPreaching(result.today)
  })

  it('模型失败（返回非法 JSON）时回退，建议非空且无药名', async () => {
    const result = await dailyMirror({ carePlan, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [], llm: llmReturning('不是 JSON'), now: () => now })
    expect(result.today.length).toBeGreaterThan(0)
    assertNoMedicine(result)
    assertNoPreaching(result.today)
  })

  it('模型成功时用模型建议，非空且无药名', async () => {
    const result = await dailyMirror({ carePlan, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [], llm: llmReturning({ today: ['今天早点睡', '多喝温水'] }), now: () => now })
    expect(result.today).toEqual(['今天早点睡', '多喝温水'])
    assertNoMedicine(result)
    assertNoPreaching(result.today)
  })

  it('天气接口失败（weather 为 null）时仍返回建议', async () => {
    const result = await dailyMirror({ carePlan: null, jieqi: '立冬', weather: null, recentCheckins: [], recentSymptoms: [], now: () => now })
    expect(result.today.length).toBeGreaterThan(0)
  })

  it('压力连续 3 天为 5 时，模型输入带压力走势、提示词要求侧重放松，建议不说教（验收第 4 条）', async () => {
    const stress = [
      { date: '2026-10-15', score: 5 },
      { date: '2026-10-16', score: 5 },
      { date: '2026-10-17', score: 5 },
    ]
    const llm = llmReturning({ today: ['今天给自己留一段放松的时间，散散步。'] })
    const result = await dailyMirror({ carePlan: null, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [], recentStress: stress, llm, now: () => now })
    const complete = llm.complete as ReturnType<typeof vi.fn>
    const system = complete.mock.calls[0][0][0].content as string
    const user = JSON.parse(complete.mock.calls[0][0][1].content as string)
    expect(system).toContain('放松')
    expect(system).toContain('不说教')
    expect(user.recentStress).toEqual(stress)
    expect(user.relaxFocus).toBe(true)
    assertNoPreaching(result.today)
  })

  it('回退建议没有“不要”“禁止”开头的说教句', async () => {
    const stress = [
      { date: '2026-10-15', score: 5 },
      { date: '2026-10-16', score: 5 },
      { date: '2026-10-17', score: 5 },
    ]
    const result = await dailyMirror({ carePlan: null, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [], recentStress: stress, now: () => now })
    expect(result.today.length).toBeGreaterThan(0)
    assertNoPreaching(result.today)
  })
})

describe('dailyMirror 同一天只生成一次（验收第 3 条）', () => {
  it('同一天调用两次只请求一次模型', async () => {
    const identity = createIdentity()
    const store = await openStore(identity, { factory: new IDBFactory() })
    const llm = llmReturning({ today: ['今天多喝水'] })
    const input = { carePlan, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [], llm, now: () => now }
    const first = await getDailyMirror(store, input)
    const second = await getDailyMirror(store, input)
    expect(first.today).toEqual(['今天多喝水'])
    expect(second.today).toEqual(['今天多喝水'])
    expect(llm.complete).toHaveBeenCalledTimes(1)
    store.close()
  })
})

describe('走势（验收第 6 条）', () => {
  it('输出最近 14 天打卡次数与状态、压力自评分序列', () => {
    const checkins = [
      { homeworkId: 'h1', at: '2026-10-16T08:00:00.000Z' },
      { homeworkId: 'h2', at: '2026-10-16T20:00:00.000Z' },
      { homeworkId: 'h1', at: '2026-10-10T08:00:00.000Z' },
    ]
    const ratings = [{ date: '2026-10-16', score: 4 }, { date: '2026-10-17', score: 5 }]
    const stress = [{ date: '2026-10-17', score: 3 }]
    const trend = last14DayTrend(checkins, ratings, stress, now)
    expect(trend.days).toHaveLength(14)
    expect(trend.days[0]).toBe('2026-10-04')
    expect(trend.days[13]).toBe('2026-10-17')
    expect(trend.scores[12]).toBe(4) // 10-16
    expect(trend.scores[13]).toBe(5) // 10-17
    expect(trend.stress[13]).toBe(3) // 10-17
    expect(trend.checkins[12]).toBe(2) // 10-16 两次
    expect(trend.checkins[6]).toBe(1) // 10-10 一次
  })

  it('自评 1～5 校验与同一天覆盖', async () => {
    expect(validScore(0)).toBe(false)
    expect(validScore(6)).toBe(false)
    expect(validScore(3)).toBe(true)
    const identity = createIdentity()
    const store = await openStore(identity, { factory: new IDBFactory() })
    await recordSelfRating(store, 4, now)
    await recordSelfRating(store, 5, now)
    const ratings = await listSelfRatings(store)
    expect(ratings).toHaveLength(1)
    expect(ratings[0]).toEqual({ date: '2026-10-17', score: 5 })
    await recordStressRating(store, 3, now)
    await recordStressRating(store, 5, now)
    const stress = await listStressRatings(store)
    expect(stress).toHaveLength(1)
    expect(stress[0]).toEqual({ date: '2026-10-17', score: 5 })
    store.close()
  })

  it('压力连续 3 天 ≥4 判定为高压', () => {
    expect(stressHighStreak([{ date: '2026-10-15', score: 4 }, { date: '2026-10-16', score: 5 }, { date: '2026-10-17', score: 5 }], now)).toBe(true)
    expect(stressHighStreak([{ date: '2026-10-15', score: 4 }, { date: '2026-10-16', score: 3 }, { date: '2026-10-17', score: 5 }], now)).toBe(false)
  })
})
