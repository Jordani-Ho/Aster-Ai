import { check } from '../redflags'
import type { StoredConsult } from './index'
export function urgentConsult(consult:StoredConsult):boolean {
  return check(Object.values(consult.encounter.intake).flatMap(field=>Array.isArray(field)?[]:[field.value??'']).join('。')).hit
}
export function prioritizeConsults(consults:readonly StoredConsult[]):StoredConsult[]{
  return [...consults].sort((a,b)=>Number(urgentConsult(b))-Number(urgentConsult(a))||Date.parse(a.receivedAt)-Date.parse(b.receivedAt)||a.encounter.id.localeCompare(b.encounter.id))
}
