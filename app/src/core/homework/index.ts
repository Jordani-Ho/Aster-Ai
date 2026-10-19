import type { LocalStore } from '../store'
import type { Homework } from '../record/types'
import type { HeavenStamp } from '../heaven'
import { addDays, checkinDay, effectiveDay, effectiveNoon, habitAnchor, localDay, schedule } from './schedule'
export interface Checkin extends Partial<HeavenStamp> { homeworkId:string; at:string; note?:string }
export interface Assignment { homework:Homework; startsOn:string }
export interface HabitItem { homeworkId:string; title:string; detail:string; anchor:string; done:boolean }
export async function checkIn(store:LocalStore,homeworkId:string,note?:string,at=new Date(),heaven?:HeavenStamp):Promise<Checkin> {
  if (!homeworkId.trim() || !Number.isFinite(at.getTime())) throw new Error('打卡资料无效')
  const record:Checkin={homeworkId,at:at.toISOString(),...(heaven?{shichen:heaven.shichen,jieqi:heaven.jieqi,city:heaven.city}:{}),...(note?.trim()?{note:note.trim()}:{})}
  await store.put('checkins',crypto.randomUUID(),{...record})
  return record
}
// M1-23a：今天生效的随习惯作业（不按钟点提醒，只出现在镜子页“今天做这些事的时候”一栏）。
// 打卡仍写进 checkins（homeworkId + at），M1-24 的坚持率直接复用这些记录，这里不另算坚持率。
export function habitHomework(assignments: Assignment[], checkins: Checkin[], now = new Date()): HabitItem[] {
  const today = effectiveDay(now)
  const items: HabitItem[] = []
  for (const { homework, startsOn } of assignments) {
    if (!homework || typeof homework.id !== 'string' || typeof homework.title !== 'string') continue
    if (!homework.schedule || homework.schedule.kind !== 'habit') continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) continue
    const elapsed = (Date.parse(today) - Date.parse(startsOn)) / 86400000
    if (!Number.isFinite(elapsed) || elapsed < 0) continue
    if (homework.durationDays !== undefined && (!Number.isInteger(homework.durationDays) || homework.durationDays <= 0 || elapsed >= homework.durationDays)) continue
    let anchor: string
    try { anchor = habitAnchor(homework.schedule.anchor) } catch { continue }
    const done = checkins.some(record => record.homeworkId === homework.id && checkinDay(new Date(record.at)) === today)
    items.push({ homeworkId: homework.id, title: homework.title, detail: homework.detail ?? '', anchor, done })
  }
  return items
}
export async function listCheckins(store:LocalStore):Promise<Checkin[]> {
  return (await store.list('checkins')).map(({value})=>{
    if (!value || typeof value!=='object' || value instanceof Uint8Array || Array.isArray(value)) throw new Error('打卡记录损坏')
    if (typeof value.homeworkId!=='string' || typeof value.at!=='string' || !Number.isFinite(Date.parse(value.at)) || (value.note!==undefined && typeof value.note!=='string')) throw new Error('打卡记录损坏')
    return value as unknown as Checkin
  })
}
// “今日是否已完成”：与打卡同一个 checkinDay；本地 00:00–00:59 的打卡记前一天，
// 所以这一小时里打完卡要算“今天”（有效日）已完成，界面才不会以为没打上。
export function completedToday(checkins: readonly Checkin[], homeworkId: string, now = new Date()): boolean {
  const today = effectiveDay(now)
  return checkins.some(item => item.homeworkId === homeworkId && checkinDay(new Date(item.at)) === today)
}
export function sevenDayProgress(homework:Homework,checkins:Checkin[],startsOn:string,now=new Date()) {
  const anchor=effectiveNoon(now)
  const days=Array.from({length:7},(_,i)=>localDay(addDays(anchor,i-6)))
  const planned=new Set(schedule([homework],startsOn,7,days[0]).map(item=>localDay(item.at)))
  const done=new Set(checkins.filter(item=>item.homeworkId===homework.id && Date.parse(item.at)<=now.getTime()).map(item=>checkinDay(new Date(item.at))))
  const cells=days.map(day=>({day,scheduled:planned.has(day),completed:planned.has(day)&&done.has(day)}))
  return {days:cells,completed:cells.filter(item=>item.completed).length,expected:planned.size}
}
export function dueReminders(assignments:Assignment[],checkins:Checkin[],now=new Date()) {
  const today=effectiveDay(now)
  return assignments.flatMap(({homework,startsOn})=>schedule([homework],startsOn,1,today))
    .filter(item=>item.at.getTime()<=now.getTime() && !checkins.some(record=>record.homeworkId===item.homeworkId && checkinDay(new Date(record.at))===today))
}
