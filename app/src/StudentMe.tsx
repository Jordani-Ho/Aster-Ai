import { useEffect, useState, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { FamilyMember } from './core/family'
import { loadFamilyMembers, RELATION_LABELS } from './core/family'
import type { LedgerView } from './core/ledger/sync'
import { parseChainFields } from './core/ledger'
import { formatMoney } from './core/ledger/money'
import { loadProfile } from './core/intake/session'
import { FamilySettings } from './FamilySettings'
import { LedgerSettings } from './LedgerSettings'
import { TimeSettings } from './TimeSettings'
import { PushSettings } from './PushSettings'
import { SelfCheck } from './SelfCheck'
import { VersionLine } from './VersionLine'
import { themeOf } from './core/storefront'
import type { TeacherVenue } from './core/storefront/active'
import './newui.css'

// V2-17 学生·我（12）：我的老师（多馆切换）、家人、在老师这里的余额、设置。
// 设置里保留本人感受、模型、时间、通知；余额只读本机账本，没有就写“还没记过账”。
type View = 'me' | 'settings' | 'family' | 'ledger'

export interface StudentMeProps {
  store: LocalStore
  identity: Identity
  family: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active: number
  onSwitch?: (account: number) => void
  venue: TeacherVenue & { switchTo: (teacher: string) => Promise<void> }
  ledger?: { view(teacher: string, student: string): Promise<LedgerView> } | null
  stackStatus: 'offline' | 'connecting' | 'ready' | 'rejected' | 'invalid-message'
  modelSettings?: ReactNode
  sendEnvelope?: (recipient: string, envelope: import('./core/transport').Envelope) => Promise<unknown>
  onFamilyChanged?: () => void
  /** V2-23：打开当前身份（本人或正在代管的家人）的基础信息。 */
  onOpenBasics?: () => void
}

const RELATION_LABEL: Record<string, string> = RELATION_LABELS

export function StudentMe({ store, identity, family, onSwitch, venue, ledger, stackStatus, modelSettings, sendEnvelope, onFamilyChanged, onOpenBasics }: StudentMeProps) {
  const [view, setView] = useState<View>('me')
  const [alias, setAlias] = useState('')
  const [members, setMembers] = useState<FamilyMember[]>([])
  const [balance, setBalance] = useState<{ text: string; currency: string } | null>(null)

  useEffect(() => {
    let activeLoad = true
    void loadProfile(store).then(profile => { if (activeLoad) setAlias(profile.alias.value ?? '') }).catch(() => {})
    void loadFamilyMembers(store).then(rows => { if (activeLoad) setMembers(rows) }).catch(() => {})
    return () => { activeLoad = false }
  }, [store, family.length])

  useEffect(() => {
    let activeLoad = true
    if (!ledger || !venue.active) { setBalance(null); return }
    void ledger.view(venue.active, identity.publicKey).then(value => {
      if (!activeLoad || value.balance === null) return
      const currency = value.ledger.events.length ? parseChainFields(value.ledger.events[0]).currency : 'CNY'
      setBalance({ text: formatMoney(value.balance, currency), currency })
    }).catch(() => {})
    return () => { activeLoad = false }
  }, [ledger, venue.active, identity.publicKey])

  const close = () => setView('me')
  const venueName = (teacher: string): string => venue.venues[teacher]?.name || '馆'
  const venueCall = (teacher: string): string => venue.venues[teacher]?.displayName ? venue.venues[teacher].displayName + '老师' : venue.labels[teacher] || '老师 ' + teacher.slice(0, 6)
  const theme = themeOf(venue.active ? venue.venues[venue.active] ?? null : null)

  if (view === 'settings') return <SubPage title="设置" onBack={close}>
    <details className="nl-section" open><summary>模型、我的时间、通知</summary>
      {modelSettings}
      <TimeSettings store={store} />
      <PushSettings identity={identity} />
    </details>
    <SelfCheck store={store} identity={identity} teacher={venue.active} />
    <VersionLine />
  </SubPage>

  if (view === 'family') return <SubPage title="家人" onBack={close}>
    <FamilySettings store={store} identity={identity} send={sendEnvelope} onChanged={onFamilyChanged} />
  </SubPage>

  if (view === 'ledger') return <SubPage title="在老师这里的余额" onBack={close}>
    <LedgerSettings managed identity={identity} store={store} ledger={ledger as never} status={stackStatus} teacher={venue.active} teacherName={venue.call} />
  </SubPage>

  return <div className="nl-page me-page" style={{ ['--me-accent' as string]: theme.primary }}>
    <div className="nl-top"><small>自己的节奏，慢慢来</small></div>
    <div className="me-head">
      <h1>我</h1>
      <span className="me-identity"><span>{alias || '本人'}</span><span className="me-avatar" aria-hidden="true">{(alias || '本').slice(0, 1)}</span></span>
    </div>

    <section aria-label="我的老师">
      <div className="nl-top"><h2>我的老师</h2><span className="nl-meta">{venue.teachers.length} 座馆</span></div>
      {venue.teachers.length === 0 && <p className="nl-empty">还没有加入任何馆。打开老师的邀请链接即可。</p>}
      {venue.teachers.length > 0 && <div className="nl-card me-list">
        {venue.teachers.map((teacher, index) => <div className="me-row" key={teacher}>
          <span className="nl-avatar" aria-hidden="true">{venueName(teacher).slice(0, 1) || '馆'}</span>
          <span className="me-row-main"><strong>{venueName(teacher)}</strong><span>{venueCall(teacher)}</span></span>
          {teacher === venue.active
            ? <span className="ts-badge ok">当前馆</span>
            : <button type="button" className="me-switch" onClick={() => void venue.switchTo(teacher)}>切换 ›</button>}
          {index >= 0 && null}
        </div>)}
      </div>}
    </section>

    <section aria-label="家人">
      <div className="nl-top"><h2>家人</h2><button type="button" className="nl-link-button me-manage" onClick={() => setView('family')}>管理 ›</button></div>
      {members.length === 0 && <p className="nl-empty">还没有添加家人。需要时可在“管理”里添加。</p>}
      <div className="nl-card me-list">
        {members.map(member => <button type="button" className="me-row me-row-button" key={member.account} onClick={() => { onSwitch?.(member.account); setView('me') }}>
          <span className="nl-avatar warm" aria-hidden="true">{member.alias.slice(0, 1)}</span>
          <span className="me-row-main"><strong>{RELATION_LABEL[member.relation] ?? '家人'} · {member.alias}</strong><span>由你代管</span></span>
          <span className="ts-chevron">›</span>
        </button>)}
      </div>
    </section>

    <section aria-label="在老师这里的余额">
      <h2>在老师这里的余额</h2>
      <button type="button" className="nl-card me-balance" onClick={() => setView('ledger')}>
        <span className="me-row-main"><span className="nl-quiet">{venue.call || '老师'} · 一家一本账</span>
          <strong>{balance ? balance.text : '还没记过账'}</strong>
        </span>
        <span className="ts-chevron">›</span>
      </button>
    </section>

    {onOpenBasics && <button type="button" className="nl-card me-setting-row" onClick={onOpenBasics}>
      <span className="me-row-main"><strong>基础信息</strong><span>出生日期、居住城市、病史、作息</span></span>
      <span className="ts-chevron">›</span>
    </button>}
    <button type="button" className="nl-card me-setting-row" onClick={() => setView('settings')}>
      <span className="me-row-main"><strong>设置</strong><span>模型、我的时间、通知、换手机</span></span>
      <span className="ts-chevron">›</span>
    </button>
    {venue.active && <p className="nl-quiet me-note">换手机时，请{venue.call || '老师'}生成认回链接。</p>}
  </div>
}

function SubPage({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return <div className="nl-shell">
    <header className="nl-flow-head">
      <button type="button" className="nl-back" aria-label="返回" onClick={onBack}>‹</button>
      <div><h1>{title}</h1></div>
    </header>
    <div className="nl-flow-body">{children}</div>
  </div>
}
