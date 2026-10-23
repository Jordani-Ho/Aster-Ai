import { useEffect, useState, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { Wiring } from './core/wiring'
import type { LlmClient } from './core/llm'
import type { StoredConsult } from './core/inbox'
import type { SendEnvelope } from './core/inbox'
import { knownStudents } from './core/record/in-person'
import { teacherRecordsOf, type LoadedTeacherRecord } from './core/records/teacher'
import { listStudentAdherence, type StudentAdherence } from './core/inbox'
import { TeacherToday } from './TeacherToday'
import { TeacherManagement } from './TeacherManagement'
import { TeacherCarePlan } from './TeacherCarePlan'
import { VisitPage } from './VisitPage'
import { RemoteReview } from './RemoteReview'
import './newui.css'
import './teacher.css'

type Tab = 'today' | 'students' | 'manage'
type Flow = { kind: 'visit'; student?: string } | { kind: 'remote'; consult: StoredConsult } | null

// V2-16 新外壳：老师端底部三个标签“今天 / 学生 / 我的馆”。
// 旧的顶层导航（今天/面诊/远程/管理）整块删掉；面诊与远程核对都是今天页里的全屏流程。
export interface TeacherShellProps {
  identity: Identity
  store: LocalStore
  stack: Wiring | null
  llm: LlmClient | null
  gateway: string
  status: ReactNode
  ledgerPanel: ReactNode
  settings: ReactNode
}

export function TeacherShell({ identity, store, stack, llm, gateway, status, ledgerPanel, settings }: TeacherShellProps) {
  const [tab, setTab] = useState<Tab>('today')
  const [flow, setFlow] = useState<Flow>(null)

  if (flow?.kind === 'visit') return <VisitPage identity={identity} store={store} llm={llm} send={stack?.send as SendEnvelope | undefined} initialStudent={flow.student} onExit={() => setFlow(null)} />
  if (flow?.kind === 'remote') {
    if (!stack) return <div className="nl-shell"><div className="nl-page nl-signed"><h1>还连不上社区</h1><p className="nl-quiet">签字要等中继连上，资料仍在本机。</p><button type="button" className="nl-primary" onClick={() => setFlow(null)}>返回今天</button></div></div>
    return <RemoteReview identity={identity} store={store} consult={flow.consult} llm={llm} send={stack.send} ledger={stack.ledger} onExit={() => setFlow(null)} />
  }

  return <div className="nl-shell">
    {tab === 'today' && <TeacherToday identity={identity} store={store} status={status}
      onStartVisit={() => setFlow({ kind: 'visit' })} onOpenRemote={consult => setFlow({ kind: 'remote', consult })} />}
    {tab === 'students' && <TeacherStudents identity={identity} store={store} llm={llm} send={stack?.send as SendEnvelope | undefined} onVisit={student => setFlow({ kind: 'visit', student })} />}
    {tab === 'manage' && <TeacherManagement identity={identity} store={store} llm={llm} gateway={gateway} send={stack?.send} ledgerPanel={ledgerPanel} settings={settings} />}
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

// 老师·学生：第一批先把名单原样摆出来（点一位学生可定制调养方案/开始面诊），下一批再重画。
function TeacherStudents({ identity, store, llm, send, onVisit }: {
  identity: Identity
  store: LocalStore
  llm: LlmClient | null
  send?: SendEnvelope
  onVisit: (student: string) => void
}) {
  const [students, setStudents] = useState<string[]>([])
  const [records, setRecords] = useState<Record<string, LoadedTeacherRecord[]>>({})
  const [adherence, setAdherence] = useState<StudentAdherence[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const refresh = () => {
      void Promise.all([knownStudents(store), listStudentAdherence(store)]).then(async ([people, reports]) => {
        const map: Record<string, LoadedTeacherRecord[]> = {}
        for (const student of people) map[student] = await teacherRecordsOf(store, student)
        if (!active) return
        setStudents(people); setRecords(map); setAdherence(reports); setError('')
      }).catch(() => { if (active) setError('学生名单读取失败，请稍后重试。') })
    }
    refresh()
    window.addEventListener('aster:data-changed', refresh)
    return () => { active = false; window.removeEventListener('aster:data-changed', refresh) }
  }, [store])

  const nameOf = (student: string): string => {
    const alias = records[student]?.at(0)?.encounter.profile.alias.value
    return typeof alias === 'string' && alias.trim() !== '' ? alias.trim() : '学生 ' + student.slice(0, 4)
  }

  return <div className="nl-page">
    <h1>学生</h1>
    <p className="nl-meta">点开一位学生：历次病历、当前方案、坚持情况。</p>
    {error && <p role="alert" className="nl-danger-strong">{error}</p>}
    {students.length === 0 && <p className="nl-empty">还没有学生。在“我的馆 → 邀请学生”里请他们进来。</p>}
    <ul className="nl-list">
      {students.map(student => {
        const rows = records[student] ?? []
        const report = adherence.find(item => item.student === student)
        const latest = rows.at(0)?.encounter
        return <li key={student}>
          <details className="nl-card">
            <summary>
              <span className="nl-avatar" aria-hidden="true">{nameOf(student).slice(0, 1)}</span>
              <span className="nl-row-main"><strong>{nameOf(student)}</strong>
                <span>{latest ? (latest.judgment.pattern.value ?? '已签字') + ' · ' + new Date(latest.createdAt).toLocaleDateString() : '还没有签字病历'}</span>
              </span>
              {report && <span className="nl-pill muted">这周 {report.practiceDays} 天</span>}
            </summary>
            <p className="nl-quiet">已签字病历 {rows.length} 份{report ? ` · 已连续 ${report.streak} 天` : ''}</p>
            {rows.slice(0, 3).map(row => <div className="nl-homework-item" key={row.eventId}>
              <strong>{row.encounter.judgment.pattern.value ?? '未写证候'}</strong>
              <p>{new Date(row.encounter.createdAt).toLocaleDateString()} · {row.encounter.plan.prescription.value?.items.map(item => item.herb).join('、') ?? '没有方子'}</p>
            </div>)}
            <button type="button" className="nl-primary" onClick={() => onVisit(student)}>开始面诊</button>
            <details className="nl-section"><summary>这位学生的调养方案</summary>
              <TeacherCarePlan identity={identity} store={store} student={student} llm={llm} send={send} />
            </details>
          </details>
        </li>
      })}
    </ul>
  </div>
}
