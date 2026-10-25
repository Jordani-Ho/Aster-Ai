import { useState, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { Wiring } from './core/wiring'
import type { LlmClient } from './core/llm'
import type { StoredConsult } from './core/inbox'
import type { SendEnvelope } from './core/inbox'
import { TeacherToday } from './TeacherToday'
import { TeacherManagement } from './TeacherManagement'
import { TeacherStudentsPage } from './TeacherStudentsPage'
import { VisitPage } from './VisitPage'
import { RemoteReview } from './RemoteReview'
import { HallGroundwork, GroundworkNotice } from './HallGroundwork'
import './newui.css'
import './newui2.css'
import './teacher.css'

type Tab = 'today' | 'students' | 'manage'
type Flow = { kind: 'visit'; student?: string } | { kind: 'remote'; consult: StoredConsult } | null

// V2-16 新外壳：老师端底部三个标签“今天 / 学生 / 我的馆”。
// 旧的顶层导航（今天/面诊/远程/管理）整块删掉；面诊与远程核对都是全屏流程。
export interface TeacherShellProps {
  identity: Identity
  store: LocalStore
  stack: Wiring | null
  llm: LlmClient | null
  gateway: string
  status: ReactNode
  ledgerPanel?: ReactNode
  settings: ReactNode
}

export function TeacherShell({ identity, store, stack, llm, gateway, status, settings }: TeacherShellProps) {
  const [tab, setTab] = useState<Tab>('today')
  const [flow, setFlow] = useState<Flow>(null)
  const [groundwork, setGroundwork] = useState(false)
  if (groundwork) return <div className="nl-shell"><div className="nl-page"><button type="button" className="nl-back" onClick={() => setGroundwork(false)}>返回今天</button><HallGroundwork store={store} onDone={() => setGroundwork(false)} /></div></div>

  if (flow?.kind === 'visit') return <VisitPage identity={identity} store={store} llm={llm} send={stack?.send as SendEnvelope | undefined} initialStudent={flow.student} onExit={() => setFlow(null)} />
  if (flow?.kind === 'remote') {
    if (!stack) return <div className="nl-shell"><div className="nl-page nl-signed"><h1>还连不上社区</h1><p className="nl-quiet">签字要等中继连上，资料仍在本机。</p><button type="button" className="nl-primary" onClick={() => setFlow(null)}>返回今天</button></div></div>
    return <RemoteReview identity={identity} store={store} consult={flow.consult} llm={llm} send={stack.send} ledger={stack.ledger} onExit={() => setFlow(null)} />
  }

  return <div className="nl-shell">
    {tab === 'today' && <div className="nl-page"><GroundworkNotice store={store} onOpen={() => setGroundwork(true)} /></div>}
    {tab === 'today' && <TeacherToday identity={identity} store={store} status={status} send={stack?.send as SendEnvelope | undefined}
      onStartVisit={() => setFlow({ kind: 'visit' })} onOpenRemote={consult => setFlow({ kind: 'remote', consult })} />}
    {tab === 'students' && <TeacherStudentsPage identity={identity} store={store} llm={llm} send={stack?.send as SendEnvelope | undefined} ledger={stack?.ledger ?? null} onVisit={student => setFlow({ kind: 'visit', student })} />}
    {tab === 'manage' && <TeacherManagement identity={identity} store={store} llm={llm} gateway={gateway} send={stack?.send as SendEnvelope | undefined} ledger={stack?.ledger ?? null} settings={settings} />}
    <nav className="nl-tabbar" aria-label="老师底部标签">
      <button type="button" aria-current={tab === 'today' ? 'page' : undefined} onClick={() => setTab('today')}><TodayIcon />今天</button>
      <button type="button" aria-current={tab === 'students' ? 'page' : undefined} onClick={() => setTab('students')}><PeopleIcon />学生</button>
      <button type="button" aria-current={tab === 'manage' ? 'page' : undefined} onClick={() => setTab('manage')}><HomeIcon />我的馆</button>
    </nav>
  </div>
}

function TodayIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></svg>
}
function PeopleIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><circle cx="17" cy="9" r="2.4" /><path d="M15.5 14.7c2.6.4 4.5 2.3 4.5 5.3" /></svg>
}
function HomeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5" /><path d="M6 9.5V20h12V9.5" /></svg>
}
