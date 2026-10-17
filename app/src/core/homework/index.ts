import type { LocalStore } from '../store'
import type { Homework } from '../record/types'
import { addDays, localDay, schedule } from './schedule'
export interface Checkin { homeworkId:string; at:string; note?:string }
export interface Assignment { homework:Homework; startsOn:string }
export async function checkIn(store:LocalStore,homeworkId:string,note?:string,at=new Date()):Promise<Checkin> {
  if (!homeworkId.trim() || !Number.isFinite(at.getTime())) throw new Error('打卡资料无效')
  const record:Checkin={homeworkId,at:at.toISOString(),...(note?.trim()?{note:note.trim()}:{})}
  await store.put('checkins',crypto.randomUUID(),{...record})
  return record
}
export async function listCheckins(store:LocalStore):Promise<Checkin[]> {
  return (await store.list('checkins')).map(({value})=>{
    if (!value || typeof value!=='object' || value instanceof Uint8Array || Array.isArray(value)) throw new Error('打卡记录损坏')
    if (typeof value.homeworkId!=='string' || typeof value.at!=='string' || !Number.isFinite(Date.parse(value.at)) || (value.note!==undefined && typeof value.note!=='string')) throw new Error('打卡记录损坏')
    return value as unknown as Checkin
  })
}
export function sevenDayProgress(homework:Homework,checkins:Checkin[],startsOn:string,now=new Date()) {
  const days=Array.from({length:7},(_,i)=>localDay(addDays(now,i-6)))
  const planned=new Set(schedule([homework],startsOn,7,days[0]).map(item=>localDay(item.at)))
  const done=new Set(checkins.filter(item=>item.homeworkId===homework.id && Date.parse(item.at)<=now.getTime()).map(item=>localDay(new Date(item.at))))
  const cells=days.map(day=>({day,scheduled:planned.has(day),completed:planned.has(day)&&done.has(day)}))
  return {days:cells,completed:cells.filter(item=>item.completed).length,expected:planned.size}
}
export function dueReminders(assignments:Assignment[],checkins:Checkin[],now=new Date()) {
  return assignments.flatMap(({homework,startsOn})=>schedule([homework],startsOn,1,localDay(now)))
    .filter(item=>item.at.getTime()<=now.getTime() && !checkins.some(record=>record.homeworkId===item.homeworkId && localDay(new Date(record.at))===localDay(now)))
}
