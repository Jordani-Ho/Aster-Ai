import { lazy, Suspense, useState, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { Wiring } from './core/wiring'
import { persistenceLabels, type PersistenceStatus } from './core/store/persistence'
import { MirrorPage } from './MirrorPage'
import { ConsultPage } from './ConsultPage'
import { BackupSettings } from './BackupSettings'
import { LedgerSettings } from './LedgerSettings'
import { PushSettings } from './PushSettings'
import { TeacherListSettings } from './TeacherListSettings'
import { PasskeySettings } from './PasskeySettings'
import { AdvancedRecovery } from './AdvancedRecovery'
import { recoverPasskey } from './core/onboarding/identity-relay'
import { protectStore } from './core/store'
import { createBackupManager } from './core/backup'
import { communityBackupRelay } from './core/backup/relay'
import { configuredRelays } from './PasskeySettings'
import { FamilySettings } from './FamilySettings'
import type { FamilyMember } from './core/family'
import './student.css'

const HomeworkPage = lazy(() => import('./HomeworkPage').then(module => ({ default: module.HomeworkPage })))
const StudentRecordsPage = lazy(() => import('./StudentRecordsPage').then(module => ({ default: module.StudentRecordsPage })))

export interface StudentShellProps {
  store: LocalStore
  identity: Identity
  llm: LlmClient | null
  stack: Wiring | null
  stackStatus: 'offline' | 'connecting' | 'ready' | 'rejected' | 'invalid-message'
  persistence: PersistenceStatus
  defaultRelays: string[]
  onRestore: (result: Identity) => Promise<void>
  /** M1-21 的模型提示（备用模型/恢复提示）与“我的大模型”设置，由 App 传入。 */
  modelNotice?: ReactNode
  modelSettings?: ReactNode
  /** M1-22 家人子账户：家人清单、当前查看谁（0 = 本人）；业务页用家人的分片存储与身份，设置区仍用根身份。 */
  family?: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active?: number
  onSwitch?: (account: number) => void
  memberStore?: LocalStore
  memberIdentity?: Identity
  sendConsult?: (pkg: import('./core/record/types').ConsultPackage) => Promise<void>
  onFamilyChanged?: () => void
}

type Tab = 'mirror' | 'consult' | 'other'
type OtherView = 'menu' | 'records' | 'homework'

export function StudentShell({ store, identity, llm, stack, stackStatus, persistence, defaultRelays, onRestore, modelNotice, modelSettings, family = [], active = 0, onSwitch, memberStore: scopedStore, memberIdentity: scopedIdentity, sendConsult, onFamilyChanged }: StudentShellProps) {
  const [tab, setTab] = useState<Tab>('mirror')
  const [other, setOther] = useState<OtherView>('menu')
  const [allowReplace, setAllowReplace] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [error, setError] = useState('')
  // 业务页用当前家人的分片存储与身份；设置区（备份/账本/邀请/刷脸）永远用根身份。
  const pagesStore = scopedStore ?? store
  const pagesIdentity = scopedIdentity ?? identity
  const activeMember = family.find(member => member.account === active) ?? null

  const restoreWithBackup = async () => {
    setRecovering(true)
    try {
      const relays = await configuredRelays(store, defaultRelays)
      const { identity: found, key } = await recoverPasskey(relays)
      await onRestore(found)
      const relay = communityBackupRelay(found, relays)
      const manager = createBackupManager({ identity: found, store, relay })
      try { await manager.restoreLatest(true); await protectStore(found, key) } finally { manager.close(); relay.close() }
      setError('')
    } catch { setError('恢复未完成，请检查手机账户和社区备份后重试。') } finally { setRecovering(false) }
  }

  if (other === 'records') return <Suspense fallback={<p>正在打开病历…</p>}><StudentRecordsPage identity={pagesIdentity} store={pagesStore} onBack={() => setOther('menu')} /></Suspense>
  if (other === 'homework') return <Suspense fallback={<p>正在打开今日作业…</p>}><HomeworkPage store={pagesStore} onBack={() => setOther('menu')} /></Suspense>

  return <div className="student-shell">
    <div className="student-main">
      <p role="status" className="relay-status">中继：{stackStatus === 'ready' ? '已连接' : stackStatus === 'connecting' ? '正在连接' : stackStatus === 'rejected' ? '连接未成功，请联系老师' : '尚未连接'}</p>
      {modelNotice}
      {tab === 'mirror' && <MirrorPage key={active} store={pagesStore} llm={llm} family={family} active={active} onSwitch={onSwitch} member={activeMember} />}
      {tab === 'consult' && <ConsultPage key={active} store={pagesStore} identity={pagesIdentity} llm={llm} sendConsult={sendConsult ?? stack?.sendConsult} member={activeMember} family={family} active={active} onSwitch={onSwitch} managerIdentity={activeMember ? identity : undefined} />}
      {tab === 'other' && <main className="other-page">
        <header><p className="eyebrow">知衡 · 学生</p><h1>其他</h1></header>
        <nav className="other-menu" aria-label="其他">
          <button onClick={() => setOther('records')}>我的病历</button>
          <button onClick={() => setOther('homework')}>今日作业</button>
        </nav>
        <p role="status" className="other-relay">中继：{stackStatus === 'ready' ? '已连接' : stackStatus === 'connecting' ? '正在连接' : '尚未连接'}</p>
        {error && <p role="alert">{error}</p>}
        <FamilySettings store={store} identity={identity} onChanged={onFamilyChanged} />
        <details><summary>设置</summary>
          {modelSettings}
          <LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} members={family} />
          <TeacherListSettings store={store} />
          <h3>存储状态</h3><p role="status">{persistenceLabels[persistence]}</p>
          <BackupSettings identity={identity} store={store} />
          <PushSettings identity={identity} />
          <PasskeySettings identity={identity} store={store} defaults={defaultRelays} />
          <AdvancedRecovery store={store} onRestore={onRestore} />
        </details>
        <details><summary>换手机后找回备份</summary>
          <p>恢复会替换这台设备上的资料，请先保存需要保留的文件。照片不在中继备份中。</p>
          <label><input type="checkbox" checked={allowReplace} onChange={event => setAllowReplace(event.target.checked)} />允许用备份替换本机资料</label>
          <button disabled={!allowReplace || recovering || !globalThis.PublicKeyCredential} onClick={() => void restoreWithBackup()}>用刷脸找回备份</button>
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
