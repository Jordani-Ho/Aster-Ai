import { jieqiDate, shichenStart } from '../../../../domain/tcm/calendar'
import type { Homework } from '../record/types'
export interface Reminder { homeworkId: string; at: Date }
export function localDay(at: Date): string {
  return [at.getFullYear(), String(at.getMonth()+1).padStart(2,'0'), String(at.getDate()).padStart(2,'0')].join('-')
}
export function parseDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期须为YYYY-MM-DD')
  const [y,m,d] = value.split('-').map(Number)
  const date = new Date(y,m-1,d)
  if (localDay(date) !== value) throw new Error('日期无效')
  return date
}
export function addDays(date: Date, count: number): Date { return new Date(date.getFullYear(),date.getMonth(),date.getDate()+count) }
function dayNumber(date: Date): number { return Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000 }
function timeParts(value: string): [number,number] {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('时间须为HH:MM')
  return value.split(':').map(Number) as [number,number]
}
// startsOn 是作业生效日期；windowStart 允许查询较晚的窗口而不重置 durationDays。
export function schedule(homework: Homework[], startsOn: string, days: number, windowStart = startsOn): Reminder[] {
  if (!Number.isInteger(days) || days < 0 || days > 3660) throw new Error('排程天数须为0至3660整数')
  const start = parseDay(startsOn), window = parseDay(windowStart), result:Reminder[]=[]
  for (const item of homework) {
    if (item.durationDays !== undefined && (!Number.isInteger(item.durationDays) || item.durationDays <= 0)) throw new Error('持续天数须为正整数')
    // 即使窗口里没有命中，也验证输入，不静默忽略错误。
    const spec = item.schedule
    if (spec.kind === 'daily') timeParts(spec.time)
    else if (spec.kind === 'shichen') shichenStart(spec.shichen)
    else if (spec.kind === 'once') { parseDay(spec.date); timeParts(spec.time ?? '08:00') }
    else if (spec.kind === 'jieqi') jieqiDate(start.getFullYear(),spec.jieqi)
    else throw new Error('排程类型无效')
    for (let i=0;i<days;i++) {
      const date=addDays(window,i), elapsed=dayNumber(date)-dayNumber(start), day=localDay(date)
      if (elapsed < 0 || (item.durationDays !== undefined && elapsed >= item.durationDays)) continue
      let time:[number,number]
      switch(spec.kind) {
        case 'daily': time=timeParts(spec.time); break
        case 'shichen': time=[shichenStart(spec.shichen),0]; break
        case 'jieqi': if (jieqiDate(date.getFullYear(),spec.jieqi)!==day) continue; time=[8,0]; break
        case 'once': if (spec.date!==day) continue; time=timeParts(spec.time??'08:00'); break
      }
      result.push({ homeworkId:item.id, at:new Date(date.getFullYear(),date.getMonth(),date.getDate(),...time) })
    }
  }
  return result.sort((a,b)=>a.at.getTime()-b.at.getTime() || a.homeworkId.localeCompare(b.homeworkId))
}
