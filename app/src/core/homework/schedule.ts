import { jieqiDate, shichenStart } from '../../../../domain/tcm/calendar'
import type { Homework } from '../record/types'
export interface Reminder { homeworkId: string; at: Date }
// M1-23a 随习惯作业：anchor 是学生已有的日常习惯，只用于展示与打卡，不产生钟点提醒。
export const HABIT_ANCHOR_MAX = 12
export function habitAnchor(value: unknown): string {
  if (typeof value !== 'string') throw new Error('习惯锚点必须是文字')
  const anchor = value.trim()
  if (anchor === '' || anchor.length > HABIT_ANCHOR_MAX) throw new Error(`习惯锚点需要 1 至 ${HABIT_ANCHOR_MAX} 个字`)
  if (/[\u0000-\u001f\u007f]/.test(anchor)) throw new Error('习惯锚点不能包含换行等控制字符')
  return anchor
}
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
// M1-23a 边界：子时跨零点归日。本地 00:00:00–00:59:59 的打卡算前一天（26 日子时练、27 日 00:10 打卡 → 记 26 日）。
// 用本地日期构造比较，夏令时切换在凌晨 2 点，不影响零点这一刻的归属；调用方传入合法 Date。
export function checkinDay(at: Date): string {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error('打卡时间无效')
  if (at.getHours() !== 0) return localDay(at)
  return localDay(addDays(new Date(at.getFullYear(), at.getMonth(), at.getDate()), -1))
}
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
    // 随习惯作业不排钟点提醒：只校验锚点，然后整天都不进提醒列表。
    if (spec.kind === 'habit') { habitAnchor(spec.anchor); continue }
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
