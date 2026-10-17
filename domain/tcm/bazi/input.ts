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
