import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { Wiring } from './core/wiring'
import { ConsultPage } from './ConsultPage'
import { StudentRecordsPage } from './StudentRecordsPage'
import { StudentRecordsHome } from './StudentRecordsHome'
import { StudentToday } from './StudentToday'
import { StudentMe } from './StudentMe'
import { StudentBasicsPage } from './StudentBasics'
import { HerbLibrary } from './HerbLibrary'
import { consultGate } from './core/basics'
import type { FamilyMember } from './core/family'
import { listCheckins, type Assignment } from './core/homework'
import { adherenceReport } from './core/adherence'
import { adherenceEnvelope, loadTeachers } from './core/inbox'
import { effectiveDay, checkinDay, localDay } from './core/homework/schedule'
import { useTeacherVenue } from './useTeacherVenue'
import { themeOf } from './core/storefront'
import { observationId, recordObservation } from './core/kangbi'
import { runStudentNudges, type NudgeEvent } from './core/nudge'
import './student.css'
import './newui.css'
import './newui2.css'

const HomeworkPage = lazy(() => import('./HomeworkPage').then(module => ({ default: module.HomeworkPage })))

export interface StudentShellProps {
  store: LocalStore
  identity: Identity
  llm: LlmClient | null
  stack: Wiring | null
  stackStatus: 'offline' | 'connecting' | 'ready' | 'rejected' | 'invalid-message'
  modelNotice?: ReactNode
  modelSettings?: ReactNode
  family?: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active?: number
  onSwitch?: (account: number) => void
  memberStore?: LocalStore
  memberIdentity?: Identity
  sendConsult?: (pkg: import('./core/record/types').ConsultPackage) => Promise<void>
  sendEnvelope?: (recipient: string, envelope: import('./core/transport').Envelope) => Promise<unknown>
  onFamilyChanged?: () => void
  notifySelf?: () => Promise<void>
}

type Tab = 'today' | 'records' | 'me'
type Sub = 'consult' | 'homework' | 'records' | 'basics' | 'herbs' | null

// V2-16 新外壳：学生端底部三个标签“今天 / 记录 / 我”；V2-17 把记录、问诊、我也按设计稿重画。
export function StudentShell({ store, identity, llm, stack, stackStatus, modelNotice, modelSettings, family = [], active = 0, onSwitch, memberStore: scopedStore, memberIdentity: scopedIdentity, sendConsult, sendEnvelope, onFamilyChanged, notifySelf }: StudentShellProps) {
  const [tab, setTab] = useState<Tab>('today')
  const [sub, setSub] = useState<Sub>(null)
  // V2-23：基础信息还差哪几项；新学生填全前不能第一次问诊，老用户只提示。
  const [basicsMissing, setBasicsMissing] = useState<string[]>([])
  const [basicsNote, setBasicsNote] = useState('')
  // 发起人 2026-10-24：出生日期等是被老师邀请进馆时的必填项（填错也由学生自己负责）。
  // 新学生必填项不全时，进馆后第一屏就是基础信息，填好才进首页；老用户不拦，只在首页提示。
  const [mustFill, setMustFill] = useState(false)
  const [nudges, setNudges] = useState<NudgeEvent[]>([])
  const [leaveNotice, setLeaveNotice] = useState('')
  const [departedTeacher, setDepartedTeacher] = useState('')
  const [consultNotice, setConsultNotice] = useState('')
  const pagesStore = scopedStore ?? store
  const pagesIdentity = scopedIdentity ?? identity
  const activeMember = family.find(member => member.account === active) ?? null
  const venue = useTeacherVenue(store)
  const theme = themeOf(venue.active ? venue.venues[venue.active] : null)
  useEffect(() => {
    const refresh = () => { void store.list('student-roster-leaves').then(rows => {
      const latest = rows.map(row => ({ key: row.key, value: row.value as { at?: string; text?: string } })).sort((a, b) => String(b.value.at).localeCompare(String(a.value.at)))[0]
      setLeaveNotice(typeof latest?.value.text === 'string' ? latest.value.text : '')
      setDepartedTeacher(latest?.key ?? '')
    }).catch(() => {}) }
    refresh(); window.addEventListener('aster:data-changed', refresh)
    return () => window.removeEventListener('aster:data-changed', refresh)
  }, [store])

  useEffect(() => {
    let live = true, pending = false
    const refresh = () => {
      if (pending) return
      pending = true
      void runStudentNudges({ store: pagesStore, settingsStore: store, identity: pagesIdentity, teacher: venue.active, notifySelf })
        .then(rows => { if (live) setNudges(rows) }).catch(() => {}).finally(() => { pending = false })
    }
    refresh()
    const timer = setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh); window.addEventListener('aster:data-changed', refresh)
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('aster:data-changed', refresh) }
  }, [pagesStore, store, pagesIdentity, venue.active, active, notifySelf])

  const latest = new Map<string, NudgeEvent>()
  for (const row of nudges) if (!row.actedAt && localDay(new Date(row.at)) === localDay(new Date())) {
    const key = row.kind + ':' + row.target
    if (!latest.has(key)) latest.set(key, row)
  }
  const visibleNudges = [...latest.values()]
  const bedtime = visibleNudges.find(row => row.kind === 'sleep')
  const nudgePanel = latest.size > 0 ? <section className="nl-card nl-nudge" aria-label="我的提醒">
    <h2>我的提醒</h2>{(bedtime ? [bedtime] : visibleNudges.slice(0, 3)).map(row => <p key={row.id}>{row.text}</p>)}
  </section> : null

  // M1-23a 第 5 条：把本周坚持率小结发给“我的老师”（只有数值，不含原文/身份）。
  const reportAdherence = () => {
    void (async () => {
      try {
        if (!sendEnvelope) return
        const teacher = venue.active ?? (await loadTeachers(pagesStore))[0]
        if (!teacher) return
        const [rows, checkins] = await Promise.all([pagesStore.list('homework'), listCheckins(pagesStore)])
        const assignments = rows.map(row => row.value as unknown as Assignment)
        const today = effectiveDay(new Date())
        if (checkins.some(checkin => checkinDay(new Date(checkin.at)) === today)) {
          const id = await observationId(['practice', pagesIdentity.publicKey, teacher, today])
          if (!await pagesStore.get('kangbi-observations', id)) {
            const at = new Date().toISOString()
            await recordObservation(pagesStore, { id, student: pagesIdentity.publicKey, teacher, at, periodStart: at, periodEnd: at, practiceDays: 1, teacherMinutes: 0, consultations: 0, teacherNote: null, agentNote: null, effects: { teacher: null, measurement: null } })
          }
        }
        await sendEnvelope(teacher, adherenceEnvelope(adherenceReport(assignments, checkins, effectiveDay(new Date()))))
      } catch { /* 上报不是打卡成功条件。 */ }
    })()
  }
  // 刚保存完基础信息时，先前那次（读到空资料的）核对可能才返回；用序号丢掉过期的结果，免得又跳回基础信息页。
  const gateSeq = useRef(0)
  useEffect(() => {
    let live = true
    const seq = ++gateSeq.current
    void consultGate(pagesStore).then(gate => { if (live && seq === gateSeq.current) { setBasicsMissing(gate.missing); setMustFill(!gate.allowed) } }).catch(() => {})
    return () => { live = false }
  }, [pagesStore, active, sub])

  const openConsult = () => {
    if (leaveNotice && (!venue.active || venue.active === departedTeacher)) { setConsultNotice('请先请老师重新邀请你'); return }
    void consultGate(pagesStore).then(gate => {
      if (gate.allowed) { setSub('consult'); return }
      setBasicsNote(`第一次问诊前，先把基础信息填好。还差：${gate.missing.join('、')}`)
      setSub('basics')
    }).catch(() => setSub('consult'))
  }

  useEffect(() => { if (stackStatus === 'ready') reportAdherence() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pagesStore, stackStatus, active, venue.active])

  if (mustFill) {
    return <StudentBasicsPage key={'join-' + active} store={pagesStore} identity={pagesIdentity} settingsStore={store} sendEnvelope={sendEnvelope ?? stack?.send} title={activeMember ? `${activeMember.alias}的基础信息` : '进馆：先填基础信息'}
      note="老师邀请您进馆。这是一件健康工具，请认真填好下面的基础信息，填完就能开始用了。"
      onSaved={missing => { gateSeq.current += 1; setBasicsMissing(missing); if (missing.length === 0) setMustFill(false) }} />
  }
  if (sub === 'basics') {
    return <StudentBasicsPage key={active} store={pagesStore} identity={pagesIdentity} settingsStore={store} sendEnvelope={sendEnvelope ?? stack?.send} title={activeMember ? `${activeMember.alias}的基础信息` : '基础信息'} note={basicsNote}
      onBack={() => { setBasicsNote(''); setSub(null) }}
      onSaved={missing => { setBasicsMissing(missing); if (missing.length === 0 && basicsNote) { setBasicsNote(''); setSub('consult') } }} />
  }
  if (sub === 'records') {
    return <StudentRecordsPage identity={pagesIdentity} store={pagesStore} herbStore={store} onBack={() => setSub(null)} />
  }
  if (sub === 'herbs') {
    return <div className="nl-shell" style={{ '--nl-bg': theme.background, '--nl-accent': theme.primary } as CSSProperties}>
      {nudgePanel}
      <header className="nl-flow-head"><button type="button" className="nl-back" aria-label="返回问诊" onClick={() => setSub('consult')}>‹</button><div><h1>家里的药</h1><small>一家共用一份库存</small></div></header>
      <div className="nl-flow-body"><HerbLibrary store={store} role="学生" /></div>
    </div>
  }
  if (sub === 'homework') {
    return <Suspense fallback={<div className="nl-shell"><p className="nl-page nl-quiet">正在打开今日作业…</p></div>}>
      <HomeworkPage store={pagesStore} onBack={() => setSub(null)} onCheckedIn={reportAdherence} />
    </Suspense>
  }
  if (sub === 'consult') {
    return <div className="nl-shell" style={{ '--nl-bg': theme.background, '--nl-accent': theme.primary } as CSSProperties}>
      {nudgePanel}
      <ConsultPage key={active} store={pagesStore} modelStore={store} identity={pagesIdentity} llm={llm} sendConsult={sendConsult ?? stack?.sendConsult} member={activeMember} family={family} active={active} onSwitch={onSwitch} managerIdentity={activeMember ? identity : undefined} teacher={venue.active} teacherName={venue.call} onBack={() => setSub(null)} onOpenHerbs={() => setSub('herbs')} />
    </div>
  }

  const style = { '--nl-bg': theme.background, '--nl-accent': theme.primary, '--nl-accent-deep': theme.primary } as CSSProperties
  return <div className="nl-shell" style={style}>
    {modelNotice}
    {tab === 'today' && leaveNotice && <section className="nl-card" role="status"><h2>与老师的智能体失联</h2><p>{leaveNotice}</p></section>}
    {tab === 'today' && consultNotice && <p role="status" className="nl-card">{consultNotice}</p>}
    {nudgePanel}
    {tab === 'today' && basicsMissing.length > 0 && <button type="button" className="nl-card basics-banner" onClick={() => { setBasicsNote(''); setSub('basics') }}>
      <strong>基础信息还差：{basicsMissing.join('、')}</strong><span>补齐后老师才看得到您的年龄和八字 ›</span>
    </button>}
    {tab === 'today' && <StudentToday
      store={pagesStore} modelStore={store} settingsStore={store} identity={pagesIdentity} llm={llm}
      teacher={venue.active} teacherCall={venue.call} teacherName={venue.name}
      teacherCity={venue.active ? venue.cities[venue.active] ?? null : null}
      canRequestAppointment={venue.active ? venue.appointmentAvailability[venue.active] !== false : false}
      member={activeMember} family={family} active={active} onSwitch={onSwitch}
      onConsult={openConsult} onHomework={() => setSub('homework')} onCheckedIn={reportAdherence} sendEnvelope={sendEnvelope ?? stack?.send} />}
    {tab === 'records' && <StudentRecordsHome store={pagesStore} identity={pagesIdentity} onOpenAllRecords={() => setSub('records')} />}
    {tab === 'me' && <StudentMe store={store} identity={identity} family={family} active={active} onSwitch={onSwitch}
      venue={venue} ledger={stack?.ledger ?? null} stackStatus={stackStatus} modelSettings={modelSettings}
      sendEnvelope={sendEnvelope} onFamilyChanged={onFamilyChanged} onOpenBasics={() => { setBasicsNote(''); setSub('basics') }} />}
    <p role="status" className="nl-status" style={{ padding: '0 20px' }}>中继：{stackStatus === 'ready' ? '已连接' : stackStatus === 'connecting' ? '正在连接' : stackStatus === 'rejected' ? '连接未成功，请联系老师' : '尚未连接'}</p>
    <nav className="nl-tabbar" aria-label="学生底部标签">
      <button type="button" aria-current={tab === 'today' ? 'page' : undefined} onClick={() => setTab('today')}><TodayIcon />今天</button>
      <button type="button" aria-current={tab === 'records' ? 'page' : undefined} onClick={() => setTab('records')}><RecordsIcon />记录</button>
      <button type="button" aria-current={tab === 'me' ? 'page' : undefined} onClick={() => setTab('me')}><MeIcon />我</button>
    </nav>
  </div>
}

function TodayIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></svg>
}
function RecordsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5M4 19h16" /><path d="m7 15 4-4 3 3 4-6" /></svg>
}
function MeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.2" /><path d="M5 20c0-3.6 3.1-5.8 7-5.8s7 2.2 7 5.8" /></svg>
}
