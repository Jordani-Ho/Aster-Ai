import { TimeZone, TimeStruct, TzDatabase } from 'timezonecomplete'
import tzdata from 'tzdata'
import { BaziInputError } from './input'

// Explicit data prevents auto-discovery from selecting browser/global/Node data.
// This entire module is loaded only by the lazy conversion engine.
TzDatabase.init(tzdata)
const minute = 60000

function zone(name: string): TimeZone {
  // Named zones only, never TimeZone.local() or host rules.
  if (!Object.prototype.hasOwnProperty.call(tzdata.zones,name)) throw new BaziInputError('INVALID_TIME_ZONE')
  return TimeZone.zone(name)
}
export function offsetAt(instant: number, name: string): number {
  return Math.round(zone(name).offsetForUtc(TimeStruct.fromUnix(Math.trunc(instant))) * minute)
}
export function standardOffset(instant: number, name: string): number {
  return Math.round(zone(name).standardOffsetForUtc(TimeStruct.fromUnix(Math.trunc(instant))) * minute)
}
export function nearbyOffsets(wall: number, name: string): number[] {
  return [...new Set([-48,-24,-12,0,12,24,48].map(h => offsetAt(wall+h*3600000,name)))]
}
export function clockCandidates(wall: number, name: string, offsets = nearbyOffsets(wall,name)): number[] {
  // Round-trip each distinct offset. Gaps have no candidates; folds have two.
  // offsetForZone() is deliberately avoided: it silently normalizes clock gaps.
  return offsets.map(offset => wall-offset).filter(utc => utc+offsetAt(utc,name) === wall).sort((a,b)=>a-b)
}
export function localClock(instant: number, name: string): string {
  // Display rounds to HKO minute precision; comparisons retain exact seconds.
  const rounded = Math.round(instant/minute)*minute
  return new Date(rounded+offsetAt(rounded,name)).toISOString().slice(11,16)
}
export function possibleIntervals(date: number, name: string, start: number, end: number): [number,number][] {
  const offsets = nearbyOffsets(date+12*3600000,name)
  const samples: number[] = []
  for(let m=start;m<end;m++) samples.push(...clockCandidates(date+m*minute,name,offsets))
  samples.sort((a,b)=>a-b)
  const intervals: [number,number][] = []
  for(const value of samples) {
    const last = intervals.at(-1)
    if(last && value <= last[1]) last[1] = Math.max(last[1],value+minute)
    else intervals.push([value,value+minute])
  }
  if(!intervals.length) throw new BaziInputError('NONEXISTENT_LOCAL_TIME')
  return intervals
}
