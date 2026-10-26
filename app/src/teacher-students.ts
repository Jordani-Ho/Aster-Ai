import { weekStart } from './core/adherence'

// V2-17 老师·学生名单（06）：排序、搜索、“全部 / 最近来过”筛选、坚持情况标签。
// 老师本机只有学生发来的周汇总（V2-10/V2-24 口径：只展示学生上报的数值，不做二次判定），
// 所以这里只做“本周完成几天 / 本周还没打卡 / 本周偏低”三档，不推逐日打卡。
export interface StudentWeekSummary {
  weekStart: string
  weeklyRate: number | null
  streak: number
  practiceDays: number
  scheduled: number
  done: number
}

export interface StudentRowInput {
  student: string
  alias: string
  /** 代管人称呼（家人问诊时填）；本人问诊省略。 */
  managedBy?: string
  /** 最近一次问诊/病历时间；没有就 null。 */
  lastAt: string | null
  report: StudentWeekSummary | null
  city?: string | null
  remote?: boolean
}

export interface StudentRow extends StudentRowInput {
  status: 'met' | 'low' | 'none' | 'unknown'
  weekLabel: string
  recent: boolean
}

export const RECENT_DAYS = 30

export function currentWeekReport(report: StudentWeekSummary | null, today: string): StudentWeekSummary | null {
  if (!report) return null
  return report.weekStart >= weekStart(today) ? report : null
}

export function weekStatus(report: StudentWeekSummary | null): StudentRow['status'] {
  if (!report) return 'unknown'
  if (report.practiceDays === 0) return 'none'
  if (report.weeklyRate !== null && report.weeklyRate < 0.5) return 'low'
  return 'met'
}

export function weekLabel(report: StudentWeekSummary | null): string {
  if (!report) return '还没发来坚持小结'
  if (report.practiceDays === 0) return '本周还没打卡'
  return `本周 ${report.practiceDays}/${Math.max(report.scheduled, report.practiceDays)}`
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000
}

export function isRecent(lastAt: string | null, today: string): boolean {
  if (!lastAt) return false
  const day = lastAt.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const diff = daysBetween(day, today)
  return Number.isFinite(diff) && diff >= 0 && diff <= RECENT_DAYS
}

export function buildStudentRows(inputs: readonly StudentRowInput[], today: string): StudentRow[] {
  return inputs.map(input => {
    const report = currentWeekReport(input.report, today)
    return {
      ...input,
      report,
      status: weekStatus(report),
      weekLabel: weekLabel(report),
      recent: isRecent(input.lastAt, today),
    }
  }).sort((left, right) => {
    const leftAt = left.lastAt ?? ''
    const rightAt = right.lastAt ?? ''
    return rightAt.localeCompare(leftAt) || left.alias.localeCompare(right.alias)
  })
}

export function filterStudentRows(rows: readonly StudentRow[], options: { search?: string; recentOnly?: boolean } = {}): StudentRow[] {
  const search = (options.search ?? '').trim().toLowerCase()
  return rows.filter(row => {
    if (options.recentOnly && !row.recent) return false
    if (search === '') return true
    return row.alias.toLowerCase().includes(search)
  })
}

/** 首页/名单上显示“上次问诊 10月8日”。 */
export function lastVisitLabel(lastAt: string | null): string {
  if (!lastAt) return '还没有问诊'
  const time = Date.parse(lastAt)
  if (!Number.isFinite(time)) return '还没有问诊'
  const day = new Date(time)
  return `上次问诊 ${day.getMonth() + 1}月${day.getDate()}日`
}
