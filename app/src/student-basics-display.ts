import type { LocalStore } from './core/store'
import type { Encounter } from './core/record/types'
import { validReady } from './core/roster/basics-ready'
import { validCityName } from './core/city'

export type StudentBasicsDisplay = { alias:string; gender:'male'|'female'|'other'; age:number; city:string; bazi:Encounter['profile']['bazi']['value']; at:number }
export async function loadStudentBasics(store:LocalStore, student:string):Promise<StudentBasicsDisplay|null> {
  const [row, member] = await Promise.all([store.get('teacher-student-basics',student),store.get('teacher-students',student)])
  if (!row || typeof row !== 'object' || Array.isArray(row) || !member || typeof member !== 'object' || Array.isArray(member)) return null
  const {at,...payload} = row as Record<string,unknown>
  if (!validReady(payload) || !Number.isSafeInteger(at) || (at as number)<=0 || (member as {student?:unknown}).student !== student) return null
  const roster=member as {city?:unknown;cityUpdatedAt?:unknown}
  const city=validCityName(roster.city) && Number.isSafeInteger(roster.cityUpdatedAt) && (roster.cityUpdatedAt as number)>(at as number) ? roster.city : payload.city as string
  return {...payload,city,at} as StudentBasicsDisplay
}
export function sortByBasics<T extends {basics:StudentBasicsDisplay|null}>(rows:readonly T[]):T[] {
  return [...rows].sort((a,b)=>Number(Boolean(b.basics))-Number(Boolean(a.basics)))
}
export function applyStudentBasics(encounter:Encounter, basics:StudentBasicsDisplay):Encounter {
  const next=structuredClone(encounter)
  for(const key of ['alias','gender','age','bazi','city'] as const) Object.assign(next.profile[key],{value:basics[key],source:basics[key]===null?'unknown':'student'})
  return next
}
export function basicsLine(b:StudentBasicsDisplay):string {
  return [b.gender==='male'?'男':b.gender==='female'?'女':'其他',`${b.age} 岁`,b.city].join(' · ')
}
