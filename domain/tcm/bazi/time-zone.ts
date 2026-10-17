const minute = 60000
const formatters = new Map<string, Intl.DateTimeFormat>() // time-zone formatters only, no birth data
export class BaziInputError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'BaziInputError'; this.code = code }
}
export function parseDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BaziInputError('INVALID_DATE')
  const [y, m, d] = date.split('-').map(Number)
  const value = Date.UTC(y, m - 1, d)
  if (y < 1900 || y > 2100 || new Date(value).toISOString().slice(0, 10) !== date) {
    throw new BaziInputError('INVALID_DATE')
  }
  return value
}
export function parseTime(time: string, allowEnd = false): number {
  if (allowEnd && time === '24:00') return 1440
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BaziInputError('INVALID_TIME')
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
}
function formatter(zone: string) {
  let f = formatters.get(zone)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB-u-ca-iso8601-nu-latn', { timeZone: zone,
        year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit',
        hourCycle:'h23', timeZoneName:'long' })
    } catch { throw new BaziInputError('INVALID_TIME_ZONE') }
    formatters.set(zone, f)
  }
  return f
}
export function zonedParts(instant: number, zone: string) {
  const p: Record<string, string> = {}
  for (const part of formatter(zone).formatToParts(instant)) if (part.type !== 'literal') p[part.type] = part.value
  return p
}
export function offsetAt(instant: number, zone: string): number {
  const p = zonedParts(instant, zone)
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return wall - Math.floor(instant / 1000) * 1000
}
export function nearbyOffsets(wall: number, zone: string): number[] {
  return [...new Set([-48,-24,-12,0,12,24,48].map(h => offsetAt(wall + h * 3600000, zone)))]
}
export function clockCandidates(wall: number, zone: string, offsets = nearbyOffsets(wall, zone)): number[] {
  return offsets.map(offset => wall - offset).filter(utc => utc + offsetAt(utc, zone) === wall).sort((a,b) => a-b)
}
// Intl exposes historical civil offsets and localized standard/daylight names, not a DST bit.
// For daylight/summer names, find a nearby standard observation in the same offset regime.
// The 3h filter excludes date-line moves (e.g. Samoa) while allowing double summer time.
export function standardOffset(instant: number, zone: string): number {
  const current = offsetAt(instant, zone)
  if (!/Daylight|Summer/.test(zonedParts(instant, zone).timeZoneName)) return current
  const year = new Date(instant).getUTCFullYear()
  const samples: number[] = []
  // Include winters several years away: wartime summer time can last for years.
  for(let y=year-6;y<=year+6;y++) for(let m=0;m<12;m++) samples.push(Date.UTC(y,m,15,12))
  samples.sort((a,b)=>Math.abs(a-instant)-Math.abs(b-instant))
  for (const sample of samples) {
      const offset = offsetAt(sample, zone)
      if (current > offset && current - offset <= 180 * minute
        && !/Daylight|Summer/.test(zonedParts(sample, zone).timeZoneName)) return offset
  }
  throw new BaziInputError('STANDARD_OFFSET_UNAVAILABLE')
}
export function localClock(instant: number, zone: string): string {
  // Display to nearest minute, matching the published HKO precision. Comparisons use exact seconds.
  const p = zonedParts(Math.round(instant / minute) * minute, zone)
  return `${p.hour}:${p.minute}`
}
export function possibleIntervals(date: number, zone: string, start: number, end: number): [number,number][] {
  const offsets = nearbyOffsets(date + 12 * 3600000, zone)
  const samples: number[] = []
  for(let m = start; m < end; m++) samples.push(...clockCandidates(date + m * minute, zone, offsets))
  samples.sort((a,b)=>a-b)
  const intervals: [number,number][] = []
  for(const value of samples) {
    const last = intervals.at(-1)
    if(last && value <= last[1]) last[1] = Math.max(last[1], value + minute)
    else intervals.push([value,value+minute])
  }
  if(!intervals.length) throw new BaziInputError('NONEXISTENT_LOCAL_TIME')
  return intervals
}
