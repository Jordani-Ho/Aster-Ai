import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { checkIn } from '../homework'
import { addDays, localDay } from '../homework/schedule'
import { saveTonguePhoto, tongueRecord } from '../tongue'
import { listSelfRatings, last14DayTrend, mirrorShichenNotice, mirrorTrendNote, recordSelfRating } from '../mirror/trend'
import {
  CITY_UNKNOWN_HINT, DEFAULT_MIRROR_SHICHEN, DEFAULT_TIME_DISPLAY,
  cityByName, formatHeavenTime, heavenAt, jieqiAt, loadMirrorShichen, loadTimeDisplay,
  saveMirrorShichen, saveTimeDisplay, shichenOfMinutes, trueSolarMinutes, type TimeDisplay,
} from './index'

// 验收算例用的两座城市：西经 118.24°（洛杉矶）与东经 116.40°（北京）。
const la = cityByName('洛杉矶')!
const beijing = cityByName('北京市')!
// 用同一套本地日期换算，测试不依赖运行机器的时区。
const now = new Date('2026-10-18T20:00:00Z')
const day = localDay(now)
const prior = localDay(addDays(now, -1))

describe('V2-02 验收 1：同一 UTC 时刻，两地真太阳时与时辰各自正确', () => {
  it('UTC 2026-10-19 04:00 → 洛杉矶真太阳时 20:22（戌），北京真太阳时 12:00（午）', () => {
    const at = Date.UTC(2026, 9, 19, 4, 0, 0)
    const west = heavenAt(at, la)
    const east = heavenAt(at, beijing)

    // 当地钟点与日期由 Intl 时区换算得出，与真太阳时无关。
    expect(east).toMatchObject({ city: '北京市', localDate: '2026-10-19', clock: '12:00', solar: true })
    expect(west).toMatchObject({ city: '洛杉矶', localDate: '2026-10-18', clock: '21:00', solar: true })
    expect(west.shichen).not.toBe(east.shichen)
    expect(east.shichen).toBe('午')
    expect(west.shichen).toBe('戌')

    // 真太阳时 = UTC + 经度 × 4 分钟 + 均时差；这里只断言到分钟级区间，不绑死均时差实现。
    const minutes = (clock: string) => Number(clock.slice(0, clock.indexOf(':'))) * 60 + Number(clock.slice(clock.indexOf(':') + 1))
    expect(minutes(west.solarClock)).toBeGreaterThanOrEqual(20 * 60 + 20)
    expect(minutes(west.solarClock)).toBeLessThanOrEqual(20 * 60 + 25)
    expect(minutes(east.solarClock)).toBeGreaterThanOrEqual(11 * 60 + 58)
    expect(minutes(east.solarClock)).toBeLessThanOrEqual(12 * 60 + 3)
  })

  it('经度每差 15° 真太阳时差 1 小时，均时差按同一时刻计算', () => {
    const at = Date.UTC(2026, 9, 19, 4, 0, 0)
    const diff = trueSolarMinutes(at, beijing.longitude) - trueSolarMinutes(at, la.longitude)
    // 116.40° −(−118.24°) = 234.64° ≈ 938.6 分钟 ≈ 15 小时 38 分，跨零点后取同一天内的差值。
    expect(diff).toBeGreaterThan(938)
    expect(diff).toBeLessThan(939)
  })

  it('时辰按两小时一段：子时跨零点，边界按真太阳时的整点切', () => {
    expect(shichenOfMinutes(1439)).toBe('子') // 23:59
    expect(shichenOfMinutes(0)).toBe('子') // 00:00
    expect(shichenOfMinutes(59)).toBe('子')
    expect(shichenOfMinutes(60)).toBe('丑')
    expect(shichenOfMinutes(419)).toBe('卯')
    expect(shichenOfMinutes(420)).toBe('辰')
    expect(shichenOfMinutes(720)).toBe('午')
    expect(shichenOfMinutes(840)).toBe('未')
    expect(shichenOfMinutes(-1)).toBe('子')
  })

  it('城市未知时退回设备时区的钟点时辰，并给出补城市提示', () => {
    const at = Date.UTC(2026, 9, 19, 4, 0, 0) // 北京 12:00
    const fallback = heavenAt(at, null, { timeZone: 'Asia/Shanghai' })
    expect(fallback).toMatchObject({ city: null, solar: false, clock: '12:00', shichen: '午', solarClock: '12:00' })
    expect(CITY_UNKNOWN_HINT).toContain('城市')
  })

  it('夏令时两天按 Intl 时区算当地钟点，真太阳时只看经度不受夏令时影响', () => {
    // 洛杉矶 2026-10-31 00:30 PDT 与 2026-11-01 01:30 PST（当天 02:00 退回 PST）。
    expect(heavenAt(Date.parse('2026-10-31T07:30:00Z'), la)).toMatchObject({ localDate: '2026-10-31', clock: '0:30' })
    expect(heavenAt(Date.parse('2026-11-01T08:30:00Z'), la)).toMatchObject({ localDate: '2026-11-01', clock: '1:30' })
    // 两个时刻的经度修正与均时差几乎相同，时辰都落在子时。
    expect(heavenAt(Date.parse('2026-10-31T07:30:00Z'), la).shichen).toBe('子')
    expect(heavenAt(Date.parse('2026-11-01T08:30:00Z'), la).shichen).toBe('子')
  })
})

describe('V2-02 验收 2：节气按天文时刻，再换算成当地日期', () => {
  it('2026 年冬至 UTC 2026-12-21 20:50：北京 12-22，洛杉矶 12-21', () => {
    const solstice = Date.UTC(2026, 11, 21, 20, 50, 14)
    expect(jieqiAt(solstice, 'Asia/Shanghai')).toMatchObject({ name: '冬至', localDate: '2026-12-22', at: solstice })
    expect(jieqiAt(solstice, 'America/Los_Angeles')).toMatchObject({ name: '冬至', localDate: '2026-12-21', at: solstice })

    // 同一时刻的两地天时：节气名相同，当地日期不同。
    expect(heavenAt(solstice, beijing)).toMatchObject({ jieqi: '冬至', localDate: '2026-12-22' })
    expect(heavenAt(solstice, la)).toMatchObject({ jieqi: '冬至', localDate: '2026-12-21' })
  })

  it('天文时刻前一秒仍属上一个节气', () => {
    const solstice = Date.UTC(2026, 11, 21, 20, 50, 14)
    expect(jieqiAt(solstice - 1000, 'Asia/Shanghai').name).toBe('大雪')
    expect(jieqiAt(solstice - 1000, 'America/Los_Angeles').name).toBe('大雪')
  })

  it('2026 年立春 UTC 02-03 20:02：北京 02-04，洛杉矶 02-03', () => {
    const lichun = Date.UTC(2026, 1, 3, 20, 2, 8)
    expect(jieqiAt(lichun, 'Asia/Shanghai').localDate).toBe('2026-02-04')
    expect(jieqiAt(lichun, 'America/Los_Angeles').localDate).toBe('2026-02-03')
  })
})

describe('V2-02 验收 3：timeDisplay 三种取值的显示结果', () => {
  const time = { shichen: '辰', clock: '8:20' }
  it('shichen / clock / both 三种输出', () => {
    expect(formatHeavenTime(time, 'shichen')).toBe('辰时')
    expect(formatHeavenTime(time, 'clock')).toBe('8:20')
    expect(formatHeavenTime(time, 'both')).toBe('辰时 · 8:20')
  })
  it('配置项默认 both，非法值不落库', async () => {
    const store = await openStore(createIdentity(), { factory: new IDBFactory() })
    expect(await loadTimeDisplay(store)).toBe(DEFAULT_TIME_DISPLAY)
    expect(DEFAULT_TIME_DISPLAY).toBe('both')
    await saveTimeDisplay(store, 'clock')
    expect(await loadTimeDisplay(store)).toBe('clock')
    await expect(saveTimeDisplay(store, 'bogus' as TimeDisplay)).rejects.toThrow('时间显示方式无效')
    store.close()
  })
})

describe('V2-02 验收 4：照镜子时辰与走势对照', () => {

  it('镜子时辰默认辰时，可改并校验', async () => {
    const store = await openStore(createIdentity(), { factory: new IDBFactory() })
    expect(await loadMirrorShichen(store)).toBe(DEFAULT_MIRROR_SHICHEN)
    expect(DEFAULT_MIRROR_SHICHEN).toBe('辰')
    await saveMirrorShichen(store, '午')
    expect(await loadMirrorShichen(store)).toBe('午')
    await expect(saveMirrorShichen(store, '辰时')).rejects.toThrow('照镜子时辰无效')
    store.close()
  })

  it('辰时记录进走势，午时记录不参与对照并带提示', () => {
    const ratings = [
      { date: prior, score: 2, shichen: '午' },
      { date: day, score: 4, shichen: '辰' },
    ]
    const trend = last14DayTrend([], ratings, [], now, { shichen: '辰' })
    expect(trend.excluded).toBe(1)
    expect(trend.scores[13]).toBe(4)
    expect(trend.scores[12]).toBeNull()
    expect(mirrorTrendNote(trend)).toBe('有 1 条记录时辰不同，不参与对照。')
    // 没传时辰（旧调用）时全部照旧参与。
    expect(last14DayTrend([], ratings, [], now).excluded).toBe(0)
    expect(mirrorTrendNote(last14DayTrend([], ratings, [], now))).toBeNull()
  })

  it('到了选定的时辰且今天还没照镜子，提示照镜子', () => {
    expect(mirrorShichenNotice({ shichen: '辰' }, '辰', false)).toBe('辰时到了，照照镜子吧。')
    expect(mirrorShichenNotice({ shichen: '辰' }, '辰', true)).toBeNull()
    expect(mirrorShichenNotice({ shichen: '巳' }, '辰', false)).toBeNull()
  })
})

describe('V2-02 第 5 条：每条新记录带上 { shichen, jieqi, city }', () => {
  it('状态自评、打卡、舌象都落同一天时', async () => {
    const store = await openStore(createIdentity(), { factory: new IDBFactory() })
    const at = new Date('2026-10-18T20:00:00Z')
    const heaven = { shichen: '辰', jieqi: '霜降', city: '北京市' }

    await recordSelfRating(store, 4, at, heaven)
    expect((await listSelfRatings(store))[0]).toMatchObject({ score: 4, ...heaven })

    const checkin = await checkIn(store, 'synthetic-homework', undefined, at, heaven)
    expect(checkin).toMatchObject(heaven)
    expect((await store.list('checkins'))[0].value).toMatchObject(heaven)

    await saveTonguePhoto(store, { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xda]), type: 'image/jpeg' },
      { now: () => at, heaven, codec: { decode: async () => ({ source: {}, width: 10, height: 10 }), draw: () => ({ toJpeg: async () => new Uint8Array([0xff, 0xd8]) }) } })
    expect((await tongueRecord(store, day))?.heaven).toEqual(heaven)
    store.close()
  })

  it('没传天时就不写空字段', async () => {
    const store = await openStore(createIdentity(), { factory: new IDBFactory() })
    await recordSelfRating(store, 3, new Date('2026-10-18T20:00:00Z'))
    expect((await listSelfRatings(store))[0]).toEqual({ date: day, score: 3 })
    store.close()
  })
})
