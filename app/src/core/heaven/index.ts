// 天时（V2-02）：时辰按当地真太阳时，节气按天文时刻换算成当地日期，另带所在城市。
// 只做时间与日期换算，不做健康判断；城市未知时退回设备时区的钟点时辰。
import { Solar } from 'lunar-typescript'
import cityData from '../../../../domain/tcm/bazi/cities.json'
import { equationOfTime } from '../../../../domain/tcm/bazi/solar-time'
import { meridians } from '../../../../domain/tcm/calendar'
import { JIEQI_CHRONO } from '../../../../domain/tcm/seasonal'
import { loadProfile } from '../intake/session'
import type { LocalStore } from '../store'

export interface HeavenCity {
  nameZh: string
  longitude: number
  timeZone: string
}

/** 每条新记录带的三项：时辰、节气、城市（城市未知为 null）。 */
export interface HeavenStamp {
  shichen: string
  jieqi: string
  city: string | null
}

export interface HeavenTime extends HeavenStamp {
  /** 当地日期 YYYY-MM-DD（按城市时区，未知则按设备时区）。 */
  localDate: string
  /** 当地钟点 H:mm（秒表时间，未做真太阳时修正）。 */
  clock: string
  /** 真太阳时 H:mm；城市未知时与 clock 相同。 */
  solarClock: string
  /** 是否按城市经度算了真太阳时。 */
  solar: boolean
}

export type TimeDisplay = 'shichen' | 'clock' | 'both'

export const DEFAULT_TIME_DISPLAY: TimeDisplay = 'both'
export const DEFAULT_MIRROR_SHICHEN = '辰'
export const CITY_UNKNOWN_HINT = '补上居住城市，才能按当地的太阳时定时辰。'

const TIME_DISPLAY_KEY = 'time-display'
const MIRROR_SHICHEN_KEY = 'mirror-shichen'
const DAY_MS = 86400000

export const SHICHEN: readonly string[] = meridians.map(item => item.name)

const cities = cityData

/** 城市名（中文或英文）对应到经度与时区；找不到返回 null。 */
export function cityByName(name: string | null | undefined): HeavenCity | null {
  if (typeof name !== 'string') return null
  const text = name.trim()
  if (text === '') return null
  return cities.find(city => city.nameZh === text || city.nameEn === text) ?? null
}

export function deviceTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function localParts(instant: number, timeZone: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant))
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return { date: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')), minute: Number(value('minute')) }
}

function clockText(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, '0')}`
}

/** 当地真太阳时的一日分钟数（可能为负或超过 1440，调用方自行取模）。 */
export function trueSolarMinutes(instant: number, longitude: number): number {
  const utcMinutes = (((instant % DAY_MS) + DAY_MS) % DAY_MS) / 60000
  return utcMinutes + longitude * 4 + equationOfTime(instant)
}

function clockOfMinutes(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  const hour = Math.floor(wrapped / 60)
  return clockText(hour, Math.floor(wrapped - hour * 60))
}

/** 真太阳时/钟点的一日分钟数 → 时辰名（子时跨零点，每两小时一段）。 */
export function shichenOfMinutes(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  const hour = Math.floor(wrapped / 60)
  return SHICHEN[Math.floor(((hour + 1) % 24) / 2)]
}

// 节气是全世界同一时刻：lunar-typescript 给出北京时间，这里转成 UTC 再按城市时区取当地日期。
interface JieqiMoment { name: string; at: number }
const terms = new Map<number, JieqiMoment[]>()

function termsOf(year: number): JieqiMoment[] {
  const cached = terms.get(year)
  if (cached) return cached
  const table = Solar.fromYmd(year, 6, 1).getLunar().getJieQiTable() as unknown as Record<string, Solar>
  const list = JIEQI_CHRONO.map(name => {
    // 库里的“冬至”指上一年，本年的冬至在 DONG_ZHI。
    const solar = name === '冬至' ? table.DONG_ZHI : table[name]
    return { name, at: Date.UTC(solar.getYear(), solar.getMonth() - 1, solar.getDay(), solar.getHour(), solar.getMinute(), solar.getSecond()) - 8 * 3600000 }
  })
  list.sort((left, right) => left.at - right.at)
  terms.set(year, list)
  return list
}

/** 某一时刻所处的节气（最近一个已到的天文时刻）与它落在当地的日期。 */
export function jieqiAt(at: Date | number, timeZone: string): { name: string; at: number; localDate: string } {
  const instant = typeof at === 'number' ? at : at.getTime()
  if (!Number.isFinite(instant)) throw new Error('日期无效')
  const { date } = localParts(instant, timeZone)
  const year = Number(date.slice(0, 4))
  const moments = [...termsOf(year - 1), ...termsOf(year), ...termsOf(year + 1)].sort((left, right) => left.at - right.at)
  let current = moments[0]
  for (const moment of moments) {
    if (moment.at <= instant) current = moment
    else break
  }
  return { name: current.name, at: current.at, localDate: date }
}

/** 某一时刻的天时：时辰、节气、城市、当地日期与两种钟点。 */
export function heavenAt(at: Date | number, city: HeavenCity | null, options: { timeZone?: string } = {}): HeavenTime {
  const instant = typeof at === 'number' ? at : at.getTime()
  if (!Number.isFinite(instant)) throw new Error('日期无效')
  const timeZone = city?.timeZone ?? options.timeZone ?? deviceTimeZone()
  const parts = localParts(instant, timeZone)
  const clock = clockText(parts.hour, parts.minute)
  const solar = city !== null && Number.isFinite(city.longitude)
  const solarClock = solar ? clockOfMinutes(trueSolarMinutes(instant, city.longitude)) : clock
  const minutes = solar ? trueSolarMinutes(instant, city.longitude) : parts.hour * 60 + parts.minute
  return {
    shichen: shichenOfMinutes(minutes),
    jieqi: jieqiAt(instant, timeZone).name,
    city: city?.nameZh ?? null,
    localDate: parts.date,
    clock,
    solarClock,
    solar,
  }
}

/** 展示格式：辰时 / 8:20 / 辰时 · 8:20（配置项 timeDisplay，默认两者都显示）。 */
export function formatHeavenTime(time: Pick<HeavenTime, 'shichen' | 'clock'>, display: TimeDisplay = DEFAULT_TIME_DISPLAY): string {
  const name = time.shichen.endsWith('时') ? time.shichen : `${time.shichen}时`
  if (display === 'shichen') return name
  if (display === 'clock') return time.clock
  return `${name} · ${time.clock}`
}

export function heavenStampOf(time: HeavenTime): HeavenStamp {
  return { shichen: time.shichen, jieqi: time.jieqi, city: time.city }
}

// 表层配置：智能体以后按主人习惯改这两个值，界面只读不写死。
export async function loadTimeDisplay(store: LocalStore): Promise<TimeDisplay> {
  const value = await store.get('settings', TIME_DISPLAY_KEY)
  return value === 'shichen' || value === 'clock' || value === 'both' ? value : DEFAULT_TIME_DISPLAY
}

export async function saveTimeDisplay(store: LocalStore, value: TimeDisplay): Promise<void> {
  if (value !== 'shichen' && value !== 'clock' && value !== 'both') throw new Error('时间显示方式无效')
  await store.put('settings', TIME_DISPLAY_KEY, value)
}

export async function loadMirrorShichen(store: LocalStore): Promise<string> {
  const value = await store.get('settings', MIRROR_SHICHEN_KEY)
  return typeof value === 'string' && SHICHEN.includes(value) ? value : DEFAULT_MIRROR_SHICHEN
}

export async function saveMirrorShichen(store: LocalStore, name: string): Promise<void> {
  if (!SHICHEN.includes(name)) throw new Error('照镜子时辰无效')
  await store.put('settings', MIRROR_SHICHEN_KEY, name)
}

/** 按本机档案里的居住城市算此刻的天时；没填城市时返回设备时区的钟点时辰。 */
export async function heavenNow(store: LocalStore, at: Date = new Date()): Promise<HeavenTime> {
  const profile = await loadProfile(store)
  return heavenAt(at, cityByName(profile.city.value), { timeZone: deviceTimeZone() })
}
