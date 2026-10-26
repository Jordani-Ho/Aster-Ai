import { useEffect, useState, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { StoredConsult, StudentAdherence } from './core/inbox'
import { listConsults, listStudentAdherence, sortConsultsBySubmittedAt } from './core/inbox'
import { localDay } from './core/homework/schedule'
import { formatHeavenTime, heavenNow, type HeavenTime } from './core/heaven'
import { listTeacherRecords } from './core/records/teacher'
import { loadOwnStorefront, verifyStorefrontEvent, type Storefront } from './core/storefront'
import { listAppointments, markAppointmentAttendance, type Appointment } from './core/appointments'
import { confirmDailyAppointmentInvitations, latestAppointmentInviteRun, processAppointmentCampaigns, runDailyAppointmentInvitations, type AppointmentInvitePlan } from './core/appointments/agent'
import { formatAppointmentTime } from './core/schedule/appointments'
import type { SendEnvelope } from './core/inbox'
import { listRosterLeaves, runDailyRosterLeaves, type RosterLeave } from './core/roster'
import './newui.css'

// V2-16 老师·今天（01）：最上面“学生到了？”，中间“等您签字”，下面一行“学生动态”。
// 数据只读本机已有集合：问诊包、坚持率小结；不在这里起草，也不改任何资料。
export interface TeacherTodayProps {
  identity: Identity
  store: LocalStore
  status?: ReactNode
  send?: SendEnvelope
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

export function TeacherToday({ identity, store, status, send, onStartVisit, onOpenRemote }: TeacherTodayProps) {
  const [consults, setConsults] = useState<StoredConsult[]>([])
  const [signedIds, setSignedIds] = useState<Set<string>>(new Set())
  const [studentAliases, setStudentAliases] = useState<Record<string, string>>({})
  const [adherence, setAdherence] = useState<StudentAdherence[]>([])
  const [heaven, setHeaven] = useState<HeavenTime | null>(null)
  const [storefront, setStorefront] = useState<Storefront | null>(null)
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [inviteRun, setInviteRun] = useState<{ key: string; status: 'draft' | 'delivered'; output: AppointmentInvitePlan } | null>(null)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [error, setError] = useState('')
  const [leaves, setLeaves] = useState<RosterLeave[]>([])

  useEffect(() => {
    let active = true
    const refresh = () => {
      void Promise.all([listConsults(store), listStudentAdherence(store), listTeacherRecords(store), listAppointments(store), listRosterLeaves(store)]).then(([rows, reports, records, invites, departed]) => {
        if (!active) return
        // V2-18：收件箱只按学生提交问诊的时间排序，不按任何急症/心理判断排先后。
        setConsults(sortConsultsBySubmittedAt(rows))
        setAdherence(reports)
        // “等您签字”只列还没签过的问诊；签过的留在本机等保留期限处理。
        setSignedIds(new Set(records.map(record => record.encounterId)))
        const aliases: Record<string, string> = {}
        for (const record of records) {
          const alias = record.encounter.profile.alias.value
          if (typeof alias === 'string' && alias.trim()) aliases[record.student] = alias.trim()
        }
        setStudentAliases(aliases)
        setAppointments(invites)
        setLeaves(departed)
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

  useEffect(() => {
    let active = true
    const tick = async () => {
      const now = new Date()
      if (send) try {
        const departed = await runDailyRosterLeaves(store, identity, send, now)
        if (active && departed.length) { setLeaves(await listRosterLeaves(store)); window.dispatchEvent(new Event('aster:data-changed')) }
      } catch { /* 中继暂不可用时下一次再试，不静默请出。 */ }
      if (send) try { await processAppointmentCampaigns(store, identity, send, now) } catch { /* 下一次页面检查继续尝试 */ }
      try {
        const run = await runDailyAppointmentInvitations(store, identity, send, now)
        const value = run.output as AppointmentInvitePlan
        if (active && value && Array.isArray(value.candidates)) setInviteRun({ key: run.key, status: run.status, output: value })
      } catch { /* 中继未就绪或本机暂时不可用时不阻断今天页 */ }
      try {
        const saved = await latestAppointmentInviteRun(store, identity, now)
        if (active && saved && saved.value.output && (saved.value.status === 'draft' || saved.value.status === 'delivered')) {
          const value = saved.value.output as AppointmentInvitePlan
          if (Array.isArray(value.candidates)) setInviteRun({ key: saved.key, status: saved.value.status, output: value })
        }
      } catch { /* 保留当前已显示的结果 */ }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 15_000)
    return () => { active = false; clearInterval(timer) }
  }, [store, identity, send])

  const today = localDay(new Date())
  const pending = consults.filter(consult => !signedIds.has(consult.encounter.id))
  const weekReports = adherence.filter(report => report.weekStart <= today)
  const lagging = weekReports.filter(report => report.weeklyRate !== null && report.weeklyRate < 0.5)
  const nameOf = (student: string, forMember?: string): string => {
    if (forMember) return forMember
    if (studentAliases[student]) return studentAliases[student]
    const consult = consults.find(row => row.sender === student)
    return consult ? aliasOf(consult) : '学生 ' + student.slice(0, 4)
  }
  const heroName = storefront?.name?.trim() || '我的馆'
  const teacherCity = heaven?.city || ''
  const todaysAppointments = appointments.filter(row => row.status === 'confirmed'
    && new Intl.DateTimeFormat('en-CA', { timeZone: row.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.slotStart))
      === new Intl.DateTimeFormat('en-CA', { timeZone: row.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))
    .sort((left, right) => Date.parse(left.slotStart) - Date.parse(right.slotStart))

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

    {leaves.some(row => row.day === today) && <section aria-label="今天请出的学生" className="nl-card">
      <h2>今天请出了谁</h2>
      {leaves.filter(row => row.day === today).map(row => <p key={row.student}>{nameOf(row.student)} · 已通知，原有面诊预约照常</p>)}
    </section>}

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

    <section aria-label="今天的预约">
      <div className="nl-top"><h2>今天的预约</h2><span className="nl-meta">{todaysAppointments.length} 位</span></div>
      {todaysAppointments.length === 0 && <p className="nl-empty">今天还没有确认的预约。</p>}
      <ul className="nl-list">{todaysAppointments.map(row => <li key={row.offerId}>
        <div className="nl-row">
          <span className="nl-avatar" aria-hidden="true">{nameOf(row.student).slice(0, 1)}</span>
          <span className="nl-row-main"><strong>{nameOf(row.student)}</strong><span>{formatAppointmentTime(row.slotStart, row.timezone, row.teacherCity || teacherCity, row.timezone)} · {row.minutes} 分钟</span></span>
          <span className="nl-actions">
            <button type="button" className="nl-link-button" onClick={() => void markAppointmentAttendance(store, row.offerId, 'done').then(() => listAppointments(store).then(setAppointments)).catch(() => setError('预约状态没能保存，请重试。'))}>来了</button>
            <button type="button" className="nl-link-button" onClick={() => void markAppointmentAttendance(store, row.offerId, 'no_show').then(() => listAppointments(store).then(setAppointments)).catch(() => setError('预约状态没能保存，请重试。'))}>没来</button>
          </span>
        </div>
      </li>)}</ul>
    </section>

    <section aria-label="老师智能体邀约">
      <div className="nl-top"><h2>请学生来面诊</h2><span className="nl-meta">按排班自动准备</span></div>
      {!inviteRun && <p className="nl-empty">正在查看今天可邀约的学生…</p>}
      {inviteRun && inviteRun.output.candidates.length === 0 && <p className="nl-empty">暂时没有达到复诊时间的学生。</p>}
      {inviteRun && inviteRun.output.candidates.length > 0 && !inviteRun.output.slot && <p className="nl-empty">当前排班里没有符合提前量的空时段。</p>}
      {inviteRun?.output.slot && <>
        <p className="nl-quiet">建议时段：{formatAppointmentTime(inviteRun.output.slot.slotStart, inviteRun.output.slot.timezone, teacherCity, inviteRun.output.slot.timezone)} · 同一时段可邀约 {inviteRun.output.slot.capacity + 1} 位</p>
        {inviteRun.status === 'draft' && <>
          <ul className="nl-list">{inviteRun.output.candidates.slice(0, inviteRun.output.slot.capacity + 1).map(row => <li key={row.student} className="nl-row"><span className="nl-avatar" aria-hidden="true">{row.alias.slice(0, 1)}</span><span className="nl-row-main"><strong>{row.alias}</strong><span>距上次面诊已满设定天数</span></span></li>)}</ul>
          {!send && <p className="nl-quiet">中继未连接，草稿已保存在本机；连接后可以一键发出。</p>}
          <button type="button" className="nl-primary" disabled={inviteBusy || !send} onClick={() => {
            if (!send) return
            setInviteBusy(true)
            void confirmDailyAppointmentInvitations(store, identity, send, inviteRun.key).then(run => setInviteRun({ key: run.key, status: run.status, output: run.output as AppointmentInvitePlan })).catch(() => setError('邀约没有发出，草稿仍在本机。请检查中继后重试。')).finally(() => setInviteBusy(false))
          }}>{inviteBusy ? '正在发出…' : `一键邀约 ${Math.min(inviteRun.output.candidates.length, inviteRun.output.slot.capacity + 1)} 位`}</button>
        </>}
        {inviteRun.status === 'delivered' && <p role="status" className="nl-quiet">今天的邀约已发出；学生两小时未回复时，会继续请下一位。</p>}
      </>}
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
