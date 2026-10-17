// Independent test oracle: no imports from production code or lunar-typescript.
// Gregorian JDN: USNO / Fliegel & van Flandern (1968).
// Cycles and five-rat rule: Y. T. Liu, Sexagenary Cycle, eq. (1), System 2, Time.
export const formulaSources = [
  'https://aa.usno.navy.mil/faq/JD_formula',
  'https://ytliu0.github.io/ChineseCalendar/sexagenary.html',
  'https://aa.usno.navy.mil/faq/sun_approx',
]
const stems = '甲乙丙丁戊己庚辛壬癸'
const branches = '子丑寅卯辰巳午未申酉戌亥'
const mod = (n: number, d: number) => ((n % d) + d) % d
const pair = (g: number, z: number) => stems[mod(g, 10)] + branches[mod(z, 12)]
export type Term = { name: string; utc: string; hkt: string; longitude: number; source: string }
export type KnownCase = {
  id: string; date: string; time: string; timeZone: string; longitude: number;
  utc: string; standard: string; ziHourRule: 'nextDay' | 'sameDay';
  sources: { official: string; locator: string; independent: string[]; method: string };
  expected: { year: string; month: string; day: string; hour: string };
}
export function jdn(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const a = Math.floor((14 - m) / 12)
  const yy = y + 4800 - a
  const mm = m + 12 * a - 3
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4)
    - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
}
export function referenceDay(date: string): string {
  const index = mod(jdn(date) - 2458511, 60) // 2019-01-27 = 甲子 (published anchor)
  return pair(index, index)
}
// USNO's published low-precision solar longitude, accurate to about an arcminute.
// Used only away from boundaries, and as a coarse independent check of HKO data.
export function approximateLongitude(utc: number): number {
  const d = utc / 86400000 + 2440587.5 - 2451545
  const g = (357.529 + 0.98560028 * d) * Math.PI / 180
  return mod(280.459 + 0.98564736 * d + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g), 360)
}
export function referenceYearMonth(utc: string, terms: Term[]) {
  const instant = Date.parse(utc)
  const calendarYear = new Date(instant + 8 * 3600000).getUTCFullYear()
  let solarYear: number
  let monthIndex: number // 寅 = 0, ..., 丑 = 11
  if (calendarYear === 2024) {
    const spring = Date.parse(terms.find(t => t.name === '立春')!.utc)
    solarYear = instant < spring ? 2023 : 2024
    const previous = terms.filter(t => Date.parse(t.utc) <= instant).at(-1)
    monthIndex = previous ? mod(Math.round((previous.longitude - 315) / 30), 12) : 10
  } else {
    const lon = approximateLongitude(instant)
    monthIndex = Math.floor(mod(lon - 315, 360) / 30)
    solarYear = calendarYear - (new Date(instant).getUTCMonth() < 2 && lon < 315 && lon > 270 ? 1 : 0)
  }
  const yearStem = mod(solarYear - 4, 10)
  return {
    year: pair(solarYear - 4, solarYear - 4),
    month: pair(2 * (yearStem % 5) + 2 + monthIndex, monthIndex + 2),
  }
}
export function referenceKnown(c: Pick<KnownCase, 'utc' | 'standard' | 'ziHourRule'>, terms: Term[]) {
  const date = c.standard.slice(0, 10)
  const hour = Number(c.standard.slice(11, 13))
  const minute = Number(c.standard.slice(14, 16))
  const tomorrow = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  const day = referenceDay(hour >= 23 && c.ziHourRule === 'nextDay' ? tomorrow : date)
  const timeDay = referenceDay(hour >= 23 ? tomorrow : date)
  const z = Math.floor((hour * 60 + minute + 60) / 120) % 12
  const g = (stems.indexOf(timeDay[0]) % 5) * 2 + z
  return { ...referenceYearMonth(c.utc, terms), day, hour: pair(g, z) }
}
