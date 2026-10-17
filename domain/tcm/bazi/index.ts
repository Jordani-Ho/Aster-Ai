import cityData from './cities.json'
import { BaziInputError, parseDate } from './input'
import type { Birth, Options, BaziResult, City } from './types'
export type { Birth, Options, BaziResult, City } from './types'
export { BaziInputError } from './input'

export const cities: readonly Readonly<City>[] = Object.freeze(cityData.map(city => Object.freeze({...city})))

/** Load the calendar/time-zone engine only when conversion is requested. */
export async function toBazi(birth: Birth, options: Options = {}): Promise<BaziResult> {
  const { convertToBazi } = await import('./conversion')
  return convertToBazi(birth, options)
}

export function ageAt(birthDate: string, onDate: string): number {
  const birth = parseDate(birthDate)
  const on = parseDate(onDate)
  if(on < birth) throw new BaziInputError('DATE_BEFORE_BIRTH')
  return Number(onDate.slice(0,4)) - Number(birthDate.slice(0,4)) - (onDate.slice(5) < birthDate.slice(5) ? 1 : 0)
}
