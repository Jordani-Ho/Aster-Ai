import { Solar } from 'lunar-typescript'
import cityData from './cities.json'
import { equationOfTime } from './solar-time'
import { BaziInputError, clockCandidates, localClock, parseDate, parseTime, possibleIntervals, standardOffset } from './time-zone'
export { BaziInputError } from './time-zone'

export type City = { nameZh: string; nameEn: string; longitude: number; timeZone: string }
export const cities: readonly Readonly<City>[] = Object.freeze(cityData.map(city => Object.freeze({...city})))
export type Birth = {
  date: string; city: City; time?: string | null;
  /** Half-open local clock interval on the birth date; end may be 24:00. */
  timeRange?: { start: string; end: string };
  occurrence?: 'earlier' | 'later';
}
export type Options = { trueSolarTime?: boolean; ziHourRule?: 'nextDay' | 'sameDay' }
type YearMonth = { year: string; month: string }
export type BaziResult = {
  year: string | null; month: string | null; day: string; hour: string | null;
  flags: ('时柱缺' | '出生时刻重复')[];
  ambiguous?: { pillars: ('year' | 'month')[]; term: string; termTime: string; before: YearMonth; after: YearMonth };
  repeatedTime?: { selected: 'earlier' | 'later'; choices: ['earlier', 'later'] };
}
function solarFromTimestamp(value: number) {
  const d = new Date(value)
  return Solar.fromYmdHms(d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
}
function yearMonth(utc: number): YearMonth {
  const lunar = solarFromTimestamp(utc + 8*3600000).getLunar()
  return { year:lunar.getYearInGanZhiExact(), month:lunar.getMonthInGanZhiExact() }
}
function solarTimestamp(solar: Solar) {
  return Date.UTC(solar.getYear(), solar.getMonth()-1, solar.getDay(), solar.getHour(), solar.getMinute(), solar.getSecond())
}
export function toBazi(birth: Birth, options: Options = {}): BaziResult {
  const date = parseDate(birth.date)
  if (!birth.city || !Number.isFinite(birth.city.longitude) || Math.abs(birth.city.longitude) > 180
    || typeof birth.city.timeZone !== 'string' || !birth.city.timeZone) throw new BaziInputError('INVALID_CITY')
  if (options.ziHourRule !== undefined && !['nextDay','sameDay'].includes(options.ziHourRule)
    || options.trueSolarTime !== undefined && typeof options.trueSolarTime !== 'boolean'
    || birth.occurrence !== undefined && !['earlier','later'].includes(birth.occurrence)) throw new BaziInputError('INVALID_OPTIONS')
  const known = birth.time !== undefined && birth.time !== null
  if (known) {
    if (birth.timeRange) throw new BaziInputError('TIME_AND_RANGE_CONFLICT')
    const wall = date + parseTime(birth.time!) * 60000
    const candidates = clockCandidates(wall, birth.city.timeZone)
    if (!candidates.length) throw new BaziInputError('NONEXISTENT_LOCAL_TIME')
    const selected = birth.occurrence ?? 'earlier'
    const utc = selected === 'later' ? candidates.at(-1)! : candidates[0]
    const correction = options.trueSolarTime
      ? (birth.city.longitude*4 + equationOfTime(utc))*60000
      : standardOffset(utc,birth.city.timeZone)
    const local = solarFromTimestamp(utc + correction).getLunar().getEightChar()
    local.setSect(options.ziHourRule === 'sameDay' ? 2 : 1)
    const result: BaziResult = { ...yearMonth(utc), day:local.getDay(), hour:local.getTime(), flags:[] }
    if(candidates.length > 1) {
      result.flags.push('出生时刻重复')
      result.repeatedTime = {selected,choices:['earlier','later']}
    }
    return result
  }
  const start = birth.timeRange ? parseTime(birth.timeRange.start) : 0
  const end = birth.timeRange ? parseTime(birth.timeRange.end,true) : 1440
  if(start >= end) throw new BaziInputError('INVALID_TIME_RANGE')
  const intervals = possibleIntervals(date,birth.city.timeZone,start,end)
  const before = yearMonth(intervals[0][0])
  const after = yearMonth(intervals.at(-1)![1]-1000)
  // Unknown clock: use the stated local calendar date, never a fabricated noon/midnight birth.
  const day = Solar.fromYmd(...birth.date.split('-').map(Number) as [number,number,number]).getLunar().getDayInGanZhi()
  const result: BaziResult = { ...before, day, hour:null, flags:['时柱缺'] }
  if (before.year !== after.year || before.month !== after.month) {
    const next = solarFromTimestamp(intervals[0][0] + 8*3600000).getLunar().getNextJie()
    const termUtc = solarTimestamp(next.getSolar()) - 8*3600000
    const pillars: ('year'|'month')[] = []
    if(before.year !== after.year) { pillars.push('year'); result.year = null }
    if(before.month !== after.month) { pillars.push('month'); result.month = null }
    result.ambiguous = { pillars, term:next.getName(), termTime:localClock(termUtc,birth.city.timeZone), before,after }
  }
  return result
}
export function ageAt(birthDate: string, onDate: string): number {
  const birth = parseDate(birthDate)
  const on = parseDate(onDate)
  if(on < birth) throw new BaziInputError('DATE_BEFORE_BIRTH')
  return Number(onDate.slice(0,4)) - Number(birthDate.slice(0,4)) - (onDate.slice(5) < birthDate.slice(5) ? 1 : 0)
}
