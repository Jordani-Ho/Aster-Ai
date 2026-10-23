import { useEffect, useState, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { StoredConsult, StudentAdherence } from './core/inbox'
import { listConsults, listStudentAdherence, sortConsultsBySubmittedAt } from './core/inbox'
import { localDay } from './core/homework/schedule'
import { formatHeavenTime, heavenNow, type HeavenTime } from './core/heaven'
import { listTeacherRecords } from './core/records/teacher'
import { loadOwnStorefront, verifyStorefrontEvent, type Storefront } from './core/storefront'
import './newui.css'

// V2-16 老师·今天（01）：最上面“学生到了？”，中间“等您签字”，下面一行“学生动态”。
// 数据只读本机已有集合：问诊包、坚持率小结；不在这里起草，也不改任何资料。
export interface TeacherTodayProps {
  identity: Identity
  store: LocalStore
  status?: ReactNode
  onStartVisit: () => void
  onOpenRemote: (consult: StoredConsult) => void
}

function dayLabel(at: string): string {
  const day = localDay(new Date(at))
  const today = localDay(new Date())
  const yesterday = localDay(new Date(Date.now() - 86400000))
  if (day === today) return '今天'
  if (day === yesterday) return '昨天'
  return day.slice(5).replace('-', ' 月 ') + ' 日'
}

function aliasOf(consult: StoredConsult): string {
  const alias = consult.encounter.profile.alias.value
  return typeof alias === 'string' && alias.trim() !== '' ? alias.trim() : '学生'
}

export function TeacherToday({ identity, store, status, onStartVisit, onOpenRemote }: TeacherTodayProps) {
  const [consults, setConsults] = useState<StoredConsult[]>([])
  const [signedIds, setSignedIds] = useState<Set<string>>(new Set())
  const [adherence, setAdherence] = useState<StudentAdherence[]>([])
  const [heaven, setHeaven] = useState<HeavenTime | null>(null)
  const [storefront, setStorefront] = useState<Storefront | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const refresh = () => {
      void Promise.all([listConsults(store), listStudentAdherence(store), listTeacherRecords(store)]).then(([rows, reports, records]) => {
        if (!active) return
        // V2-18：收件箱只按学生提交问诊的时间排序，不按任何急症/心理判断排先后。
        setConsults(sortConsultsBySubmittedAt(rows))
        setAdherence(reports)
        // “等您签字”只列还没签过的问诊；签过的留在本机等保留期限处理。
        setSignedIds(new Set(records.map(record => record.encounterId)))
        setError('')
      }).catch(() => { if (active) setError('本机问诊读取失败，请稍后重试。') })
    }
    refresh()
    const tick = () => { void heavenNow(store).then(time => { if (active) setHeaven(time) }).catch(() => {}) }
    tick()
    void loadOwnStorefront(store, identity).then(own => {
      const value = own.current ? verifyStorefrontEvent(own.current, identity.publicKey)?.storefront ?? null : null
      if (active) setStorefront(value)
    }).catch(() => {})
    const timer = setInterval(tick, 60_000)
    window.addEventListener('aster:data-changed', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      active = false; clearInterval(timer)
      window.removeEventListener('aster:data-changed', refresh); window.removeEventListener('focus', refresh)
    }
  }, [store, identity])

  const today = localDay(new Date())
  const pending = consults.filter(consult => !signedIds.has(consult.encounter.id))
  const weekReports = adherence.filter(report => report.weekStart <= today)
  const lagging = weekReports.filter(report => report.weeklyRate !== null && report.weeklyRate < 0.5)
  const nameOf = (student: string, forMember?: string): string => {
    if (forMember) return forMember
    const consult = consults.find(row => row.sender === student)
    return consult ? aliasOf(consult) : '学生 ' + student.slice(0, 4)
  }
  const heroName = storefront?.name?.trim() || '我的馆'

  return <div className="nl-page">
    <div className="nl-top"><small>{heroName}</small><small>{storefront?.displayName ? storefront.displayName + '老师' : ''}</small></div>
    <h1>今天</h1>
    <p className="nl-meta">{heaven ? [formatHeavenTime(heaven), heaven.jieqi, heaven.city].filter(Boolean).join(' · ') : '正在算天时…'}</p>

    <section className="nl-hero">
      <h2>学生到了？</h2>
      <p>选一位学生，或扫他手机上的码。您说，智能体记。</p>
      <button type="button" className="nl-primary" onClick={onStartVisit}>＋ 开始面诊</button>
    </section>

    {error && <p role="alert" className="nl-danger-strong">{error}</p>}

    <section aria-label="等您签字">
      <div className="nl-top"><h2>等您签字</h2><span className="nl-meta">{pending.length} 份远程问诊</span></div>
      {pending.length === 0 && <p className="nl-empty">现在没有等您签字的问诊。学生发给您之后会出现在这里。</p>}
      <ul className="nl-list">
        {pending.map(consult => <li key={consult.encounter.id}>
          <button type="button" className="nl-row" onClick={() => onOpenRemote(consult)}>
            <span className="nl-avatar" aria-hidden="true">{aliasOf(consult).slice(0, 1)}</span>
            <span className="nl-row-main">
              <strong>{aliasOf(consult)}</strong>
              <span>{consult.encounter.intake.chiefComplaint.value ?? '问诊留言'} · 草稿已备好</span>
            </span>
            <span className="nl-pill muted">{dayLabel(consult.receivedAt)}</span>
          </button>
        </li>)}
      </ul>
    </section>

    <section aria-label="学生动态">
      <h2>学生动态</h2>
      <div className="nl-card">
        {weekReports.length === 0 && <p className="nl-empty">还没有学生发来坚持小结；学生打卡后会同步到这儿。</p>}
        {lagging.length > 0 && <p>{nameOf(lagging[0].student, lagging[0].forMember)} 这周只练了 {lagging[0].practiceDays} 天</p>}
        {weekReports.length > 0 && lagging.length === 0 && <p>{weekReports.length} 位学生都在坚持</p>}
        {lagging.length > 0 && weekReports.length - lagging.length > 0 && <p className="nl-quiet">另外 {weekReports.length - lagging.length} 位都在坚持</p>}
        {lagging.length > 1 && <p className="nl-quiet">还有 {lagging.length - 1} 位这周练得少，点开“我的馆”可逐个看坚持情况。</p>}
      </div>
    </section>

    {status && <div className="nl-status">{status}</div>}
  </div>
}
