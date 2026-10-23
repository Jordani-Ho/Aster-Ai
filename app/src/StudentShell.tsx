import { lazy, Suspense, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { Wiring } from './core/wiring'
import { ConsultPage } from './ConsultPage'
import { StudentRecordsPage } from './StudentRecordsPage'
import { StudentToday } from './StudentToday'
import { SelfCheck } from './SelfCheck'
import { LedgerSettings } from './LedgerSettings'
import { PushSettings } from './PushSettings'
import { TeacherListSettings } from './TeacherListSettings'
import { TimeSettings } from './TimeSettings'
import { FamilySettings } from './FamilySettings'
import type { FamilyMember } from './core/family'
import { listCheckins, type Assignment } from './core/homework'
import { adherenceReport } from './core/adherence'
import { adherenceEnvelope, loadTeachers } from './core/inbox'
import { effectiveDay, checkinDay } from './core/homework/schedule'
import { useTeacherVenue } from './useTeacherVenue'
import { venueHeading } from './core/storefront/active'
import { themeOf } from './core/storefront'
import { observationId, recordObservation } from './core/kangbi'
import './student.css'
import './newui.css'

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
}

type Tab = 'today' | 'records' | 'me'
type Sub = 'consult' | 'homework' | null

// V2-16 新外壳：学生端底部三个标签“今天 / 记录 / 我”。
// 今天按设计稿重画；记录先把老病历页原样挪进来；我 = 老“其他”（家人、钱账、设置）+ 自评与本人感受。
export function StudentShell({ store, identity, llm, stack, stackStatus, modelNotice, modelSettings, family = [], active = 0, onSwitch, memberStore: scopedStore, memberIdentity: scopedIdentity, sendConsult, sendEnvelope, onFamilyChanged }: StudentShellProps) {
  const [tab, setTab] = useState<Tab>('today')
  const [sub, setSub] = useState<Sub>(null)
  const pagesStore = scopedStore ?? store
  const pagesIdentity = scopedIdentity ?? identity
  const activeMember = family.find(member => member.account === active) ?? null
  const venue = useTeacherVenue(store)
  const theme = themeOf(venue.active ? venue.venues[venue.active] : null)

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
  useEffect(() => { if (stackStatus === 'ready') reportAdherence() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pagesStore, stackStatus, active, venue.active])

  if (sub === 'consult') {
    return <div className="nl-shell" style={{ '--nl-bg': theme.background, '--nl-accent': theme.primary } as CSSProperties}>
      <header className="nl-flow-head">
        <button type="button" className="nl-back" aria-label="返回" onClick={() => setSub(null)}>‹</button>
        <div><h1>问诊</h1><small>说给老师听的不舒服</small></div>
      </header>
      <ConsultPage key={active} store={pagesStore} modelStore={store} identity={pagesIdentity} llm={llm} sendConsult={sendConsult ?? stack?.sendConsult} member={activeMember} family={family} active={active} onSwitch={onSwitch} managerIdentity={activeMember ? identity : undefined} teacher={venue.active} teacherName={venue.call} />
    </div>
  }
  if (sub === 'homework') {
    return <Suspense fallback={<div className="nl-shell"><p className="nl-page nl-quiet">正在打开今日作业…</p></div>}>
      <HomeworkPage store={pagesStore} onBack={() => setSub(null)} onCheckedIn={reportAdherence} />
    </Suspense>
  }

  const style = { '--nl-bg': theme.background, '--nl-accent': theme.primary, '--nl-accent-deep': theme.primary } as CSSProperties
  return <div className="nl-shell" style={style}>
    {modelNotice}
    {tab === 'today' && <StudentToday
      store={pagesStore} modelStore={store} settingsStore={store} identity={pagesIdentity} llm={llm}
      teacher={venue.active} teacherCall={venue.call} teacherName={venue.name}
      member={activeMember} family={family} active={active} onSwitch={onSwitch}
      onConsult={() => setSub('consult')} onHomework={() => setSub('homework')} onCheckedIn={reportAdherence} />}
    {tab === 'records' && <StudentRecordsPage identity={pagesIdentity} store={pagesStore} embedded onBack={() => setTab('today')} />}
    {tab === 'me' && <main className="nl-page">
      <h1>我</h1>
      {venueHeading(venue) && <p className="nl-meta">{venueHeading(venue)}</p>}
      <SelfCheck store={pagesStore} identity={pagesIdentity} teacher={venue.active} />
      <FamilySettings store={store} identity={identity} send={sendEnvelope} onChanged={onFamilyChanged} />
      <details className="nl-section"><summary>设置</summary>
        {modelSettings}
        <LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} members={family} teacher={venue.active} teacherName={venue.call} />
        <TimeSettings store={store} />
        <TeacherListSettings store={store} active={venue.active} onSwitch={teacher => void venue.switchTo(teacher)} />
        <PushSettings identity={identity} />
      </details>
    </main>}
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
