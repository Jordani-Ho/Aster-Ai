import type { LocalStore, StoreValue } from '../store'
import { loadPersonalModel } from '../llm/personal'
import { loadTemplates } from '../templates'
import { validRetentionDays } from '../records/retention'
import { listHerbs } from '../herbs'

export interface Period { start: string; end: string }
export interface Schedule {
  timezone: string
  duration: 15 | 30 | 45 | 60
  capacity: number
  week: Record<string, Period[]>
  exceptions: { date: string; kind: 'off' | 'morning-off' | 'afternoon-off' | 'extra'; periods?: Period[] }[]
}
export interface Groundwork {
  schedule: Schedule
  invitation: { mode: 'auto' | 'review'; afterDays: number }
  herbs: 'none' | 'pending' | 'ready'
  receiveRecordings: boolean
  checked: string[]
}
export const GROUNDWORK_KEY = 'hall-groundwork'
export const GROUNDWORK_ITEMS = { templates: '模板', schedule: '排班', invitation: '邀约方式', herbs: '药材库', retention: '保留期限', model: '模型' } as const
export function defaultSchedule(): Schedule {
  return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', duration: 30, capacity: 3,
    week: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), day === 0 || day === 6 ? [] : [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '17:00' }]])), exceptions: [] }
}
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value
}
export function clockMinutes(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(value)) throw Error('排班：钟点须在 00:00–24:00 之间')
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
}
function periods(value: unknown, duration: number): Period[] {
  if (!Array.isArray(value) || value.length > 96) throw Error('排班：每天须为时段列表，最多 96 段')
  let end = -1
  const result = value.map(item => {
    if (!item || typeof item !== 'object') throw Error('排班：时段无效')
    const start = clockMinutes(item.start), finish = clockMinutes(item.end)
    if (finish <= start) throw Error('排班：结束须晚于开始')
    if (start % duration || finish % duration) throw Error('排班：起止须按时段时长对齐')
    return { start: item.start as string, end: item.end as string }
  }).sort((a, b) => a.start.localeCompare(b.start))
  for (const item of result) {
    if (clockMinutes(item.start) < end) throw Error('排班：同一天时段不能重叠')
    end = clockMinutes(item.end)
  }
  return result
}
export function validateSchedule(value: unknown): Schedule {
  const v = value as Schedule
  if (!v || typeof v !== 'object') throw Error('排班：格式无效')
  // Intl 接受数字偏移等值；这里只接受 IANA 标识（UTC 也是 IANA 链接）。
  if (typeof v.timezone !== 'string' || !(v.timezone === 'UTC' || /^[A-Za-z_]+\/[A-Za-z0-9_+./-]+$/.test(v.timezone))) throw Error('排班：时区须为合法 IANA 名')
  try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }).format() } catch { throw Error('排班：时区须为合法 IANA 名') }
  if (![15, 30, 45, 60].includes(v.duration)) throw Error('排班：时长只能为 15、30、45、60 分钟')
  if (!Number.isInteger(v.capacity) || v.capacity < 1 || v.capacity > 20) throw Error('排班：每时段接待上限须为 1–20 的整数')
  if (!v.week || typeof v.week !== 'object' || Array.isArray(v.week) || Object.keys(v.week).length !== 7 || Object.keys(v.week).some(key => !/^[0-6]$/.test(key))) throw Error('排班：请填写周一至周日')
  const week = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), periods(v.week[String(day)], v.duration)]))
  if (!Array.isArray(v.exceptions) || v.exceptions.length > 366) throw Error('排班：日期例外最多 366 条')
  const seen = new Set<string>()
  const exceptions = v.exceptions.map(item => {
    if (!item || !validDate(item.date)) throw Error('日期例外：须为合法 YYYY-MM-DD 日期')
    if (seen.has(item.date)) throw Error('日期例外：同一天不能重复登记')
    seen.add(item.date)
    if (!['off', 'morning-off', 'afternoon-off', 'extra'].includes(item.kind)) throw Error('日期例外：请选择休息或临时加诊')
    const extra = item.kind === 'extra' ? periods(item.periods, v.duration) : undefined
    if (extra) {
      if (!extra.length) throw Error('日期例外：加诊须有时段')
      periods([...week[String(new Date(item.date + 'T00:00:00Z').getUTCDay())], ...extra], v.duration)
    }
    return { date: item.date, kind: item.kind, ...(extra ? { periods: extra } : {}) }
  })
  return { timezone: v.timezone, duration: v.duration, capacity: v.capacity, week, exceptions }
}
/** 日期均为老师时区的日历日期；过去的例外留存但不参与后续计算。 */
export function effectivePeriods(schedule: Schedule, date: string, today: string): Period[] {
  if (!validDate(date) || !validDate(today)) throw Error('排班日期无效')
  const base = schedule.week[String(new Date(date + 'T00:00:00Z').getUTCDay())]
  const exception = date >= today ? schedule.exceptions.find(item => item.date === date) : undefined
  if (!exception) return structuredClone(base)
  if (exception.kind === 'off') return []
  if (exception.kind === 'extra') return [...base, ...exception.periods!].sort((a, b) => a.start.localeCompare(b.start))
  const boundary = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  return base.flatMap(item => {
    const start = exception.kind === 'morning-off' ? Math.max(720, clockMinutes(item.start)) : clockMinutes(item.start)
    const end = exception.kind === 'afternoon-off' ? Math.min(720, clockMinutes(item.end)) : clockMinutes(item.end)
    return end > start ? [{ start: boundary(start), end: boundary(end) }] : []
  })
}
function normalize(value: unknown): Groundwork {
  const v = value as Groundwork
  if (!v || !v.invitation || !['auto', 'review'].includes(v.invitation.mode) || !Number.isSafeInteger(v.invitation.afterDays) || v.invitation.afterDays < 1 || v.invitation.afterDays > 3650) throw Error('邀约：方式无效，间隔须为 1–3650 的整数天')
  if (!['none', 'pending', 'ready'].includes(v.herbs)) throw Error('药材库：请选择不备药或建库')
  if (!Array.isArray(v.checked) || v.checked.some(key => typeof key !== 'string' || !Object.hasOwn(GROUNDWORK_ITEMS, key)) || new Set(v.checked).size !== v.checked.length) throw Error('基础工作确认项无效')
  if (v.receiveRecordings !== undefined && typeof v.receiveRecordings !== 'boolean') throw Error('接收录音设置无效')
  return { schedule: validateSchedule(v.schedule), invitation: { ...v.invitation }, herbs: v.herbs, receiveRecordings: v.receiveRecordings ?? true, checked: [...v.checked] }
}
export async function loadGroundwork(store: Pick<LocalStore, 'get'>): Promise<Groundwork> {
  const saved = await store.get('settings', GROUNDWORK_KEY)
  return saved === undefined ? { schedule: defaultSchedule(), invitation: { mode: 'review', afterDays: 14 }, herbs: 'none', receiveRecordings: true, checked: [] } : normalize(saved)
}
export async function saveGroundwork(store: Pick<LocalStore, 'put'>, value: Groundwork): Promise<void> {
  const clean = normalize(value)
  try { await store.put('settings', GROUNDWORK_KEY, clean as unknown as StoreValue) }
  catch (cause) { throw Error(`没保存成功：${cause instanceof Error ? cause.message : '本机存储不可用'}`) }
}
/** 默认排班只是表单初值；老师保存排班后才可用于面诊邀约。 */
export async function hasAppointmentSchedule(store: Pick<LocalStore, 'get'>): Promise<boolean> {
  const saved = await store.get('settings', GROUNDWORK_KEY) as { checked?: unknown; schedule?: unknown } | undefined
  if (!Array.isArray(saved?.checked) || !saved.checked.includes('schedule')) return false
  try { validateSchedule(saved.schedule); return true } catch { return false }
}
export function groundworkMissing(value: Groundwork): string[] {
  return Object.entries(GROUNDWORK_ITEMS).filter(([key]) => !value.checked.includes(key) || key === 'herbs' && value.herbs === 'pending').map(([, label]) => label)
}
/** 每次以已保存内容核对，不能仅凭勾选就邀请；不写入、不迁移旧部署。 */
export async function groundworkStatus(store: LocalStore): Promise<{ value: Groundwork; missing: string[] }> {
  const value = await loadGroundwork(store)
  const [templates, model, retention, herbs] = await Promise.all([loadTemplates(store), loadPersonalModel(store), store.get('settings', 'retention-days'), listHerbs(store)])
  const checked = value.checked.filter(key => key !== 'templates' || ['inquiry', 'record', 'treatment', 'prescription'].every(type => templates.some(row => row.type === type && row.status === 'active')))
    .filter(key => key !== 'model' || model !== null).filter(key => key !== 'retention' || validRetentionDays(retention))
    .filter(key => key !== 'herbs' || value.herbs === 'none' || value.herbs === 'ready' && herbs.length > 0)
  return { value, missing: groundworkMissing({ ...value, checked }) }
}
