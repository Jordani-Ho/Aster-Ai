import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { Wiring } from './core/wiring'
import { MirrorPage } from './MirrorPage'
import { ConsultPage } from './ConsultPage'
import { LedgerSettings } from './LedgerSettings'
import { PushSettings } from './PushSettings'
import { TeacherListSettings } from './TeacherListSettings'
import { TimeSettings } from './TimeSettings'
import { FamilySettings } from './FamilySettings'
import type { FamilyMember } from './core/family'
import { listCheckins, type Assignment } from './core/homework'
import { adherenceReport } from './core/adherence'
import { adherenceEnvelope, loadTeachers } from './core/inbox'
import { localDay } from './core/homework/schedule'
import './student.css'
import { observationId, recordObservation } from './core/kangbi'
import { checkinDay } from './core/homework/schedule'

const HomeworkPage = lazy(() => import('./HomeworkPage').then(module => ({ default: module.HomeworkPage })))
const StudentRecordsPage = lazy(() => import('./StudentRecordsPage').then(module => ({ default: module.StudentRecordsPage })))

export interface StudentShellProps {
  store: LocalStore
  identity: Identity
  llm: LlmClient | null
  stack: Wiring | null
  stackStatus: 'offline' | 'connecting' | 'ready' | 'rejected' | 'invalid-message'
  /** M1-21 的模型提示（备用模型）与“我的大模型”设置，由 App 传入。 */
  modelNotice?: ReactNode
  modelSettings?: ReactNode
  /** M1-22 家人子账户：家人清单、当前查看谁（0 = 本人）；业务页用家人的分片存储与身份，设置区仍用根身份。 */
  family?: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active?: number
  onSwitch?: (account: number) => void
  memberStore?: LocalStore
  memberIdentity?: Identity
  sendConsult?: (pkg: import('./core/record/types').ConsultPackage) => Promise<void>
  /** M1-23a：把“本周坚持率”小结发给老师的通用发送函数（家人用自己的身份/连接）。 */
  sendEnvelope?: (recipient: string, envelope: import('./core/transport').Envelope) => Promise<unknown>
  onFamilyChanged?: () => void
}

type Tab = 'mirror' | 'consult' | 'other'
type OtherView = 'menu' | 'records' | 'homework'

export function StudentShell({ store, identity, llm, stack, stackStatus, modelNotice, modelSettings, family = [], active = 0, onSwitch, memberStore: scopedStore, memberIdentity: scopedIdentity, sendConsult, sendEnvelope, onFamilyChanged }: StudentShellProps) {
  const [tab, setTab] = useState<Tab>('mirror')
  const [other, setOther] = useState<OtherView>('menu')
  // 业务页用当前家人的分片存储与身份；设置区（账本/邀请/推送）永远用根身份。
  const pagesStore = scopedStore ?? store
  const pagesIdentity = scopedIdentity ?? identity
  const activeMember = family.find(member => member.account === active) ?? null

  // M1-23a 第 5 条：把本周坚持率小结发给“我的老师”（只有数值，不含原文/身份）。
  // 打卡后发一次，连接就绪或切换家人时也补发一次；发送失败不影响本机打卡。
  const reportAdherence = () => {
    void (async () => {
      try {
        if (!sendEnvelope) return
        const teacher = (await loadTeachers(pagesStore))[0]
        if (!teacher) return
        const [rows, checkins] = await Promise.all([pagesStore.list('homework'), listCheckins(pagesStore)])
        const assignments = rows.map(row => row.value as unknown as Assignment)
        const today=localDay(new Date())
        if(checkins.some(c=>checkinDay(new Date(c.at))===today)) {
          const id=await observationId(['practice',pagesIdentity.publicKey,teacher,today])
          if(!await pagesStore.get('kangbi-observations',id))await recordObservation(pagesStore,{id,student:pagesIdentity.publicKey,teacher,at:new Date().toISOString(),practiceDays:1,teacherMinutes:0,consultations:0,effects:{teacher:null,self:null,measurement:null}})
        }
        await sendEnvelope(teacher, adherenceEnvelope(adherenceReport(assignments, checkins, localDay(new Date()))))
      } catch { /* 上报不是打卡成功条件。 */ }
    })()
  }
  useEffect(() => { if (stackStatus === 'ready') reportAdherence() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pagesStore, stackStatus, active])

  if (other === 'records') return <Suspense fallback={<p>正在打开病历…</p>}><StudentRecordsPage identity={pagesIdentity} store={pagesStore} onBack={() => setOther('menu')} /></Suspense>
  if (other === 'homework') return <Suspense fallback={<p>正在打开今日作业…</p>}><HomeworkPage store={pagesStore} onBack={() => setOther('menu')} onCheckedIn={reportAdherence} /></Suspense>

  return <div className="student-shell">
    <div className="student-main">
      <p role="status" className="relay-status">中继：{stackStatus === 'ready' ? '已连接' : stackStatus === 'connecting' ? '正在连接' : stackStatus === 'rejected' ? '连接未成功，请联系老师' : '尚未连接'}</p>
      {modelNotice}
      {tab === 'mirror' && <MirrorPage key={active} store={pagesStore} modelStore={store} llm={llm} family={family} active={active} onSwitch={onSwitch} member={activeMember} onCheckedIn={reportAdherence} />}
      {tab === 'consult' && <ConsultPage key={active} store={pagesStore} modelStore={store} identity={pagesIdentity} llm={llm} sendConsult={sendConsult ?? stack?.sendConsult} member={activeMember} family={family} active={active} onSwitch={onSwitch} managerIdentity={activeMember ? identity : undefined} />}
      {tab === 'other' && <main className="other-page">
        <header><p className="eyebrow">知衡 · 学生</p><h1>其他</h1></header>
        <nav className="other-menu" aria-label="其他">
          <button onClick={() => setOther('records')}>我的病历</button>
          <button onClick={() => setOther('homework')}>今日作业</button>
        </nav>
        <p role="status" className="other-relay">中继：{stackStatus === 'ready' ? '已连接' : stackStatus === 'connecting' ? '正在连接' : '尚未连接'}</p>
        <FamilySettings store={store} identity={identity} onChanged={onFamilyChanged} />
        <details><summary>设置</summary>
          {modelSettings}
          <LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} members={family} />
          <TimeSettings store={store} />
          <TeacherListSettings store={store} />
          <PushSettings identity={identity} />
        </details>
      </main>}
    </div>
    <nav className="tabbar" aria-label="底部标签">
      <button className={tab === 'mirror' ? 'tab active' : 'tab'} onClick={() => setTab('mirror')}>镜子</button>
      <button className={tab === 'consult' ? 'tab active' : 'tab'} onClick={() => setTab('consult')}>问诊</button>
      <button className={tab === 'other' ? 'tab active' : 'tab'} onClick={() => { setTab('other'); setOther('menu') }}>其他</button>
    </nav>
  </div>
}
