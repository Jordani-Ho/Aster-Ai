import { useEffect, useState, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { LedgerRecorder, SendEnvelope } from './core/inbox'
import type { LedgerView } from './core/ledger/sync'
import { parseChainFields } from './core/ledger'
import { formatMoney } from './core/ledger/money'
import { InviteSettings } from './InviteSettings'
import { StorefrontSettings } from './StorefrontSettings'
import { RetentionSettings } from './RetentionSettings'
import { ReidentifyLinks, TeacherReidentifyInbox } from './ReidentifyPages'
import { StatsSharing } from './StatsSharing'
import { LedgerSettings } from './LedgerSettings'
import { DailyMirrorCard } from './DailyMirrorCard'
import { TeacherCarePlan } from './TeacherCarePlan'
import { VenueEmblem } from './StorefrontWelcome'
import { loadOwnStorefront, verifyStorefrontEvent, themeOf, type Storefront } from './core/storefront'
import './newui.css'
import './inbox.css'

// V2-17 老师·我的馆（08）：馆卡片、邀请学生主按钮、门面、钱账总览、设置（保留期限/换手机/运行统计/模型）。
// 钱账总览只读本机账本视图；没有账本时显示“还没记过账”，不编 0。
export interface TeacherManagementProps {
  identity: Identity
  store: LocalStore
  llm: LlmClient | null
  gateway: string
  send?: SendEnvelope
  ledger?: (LedgerRecorder & { mergedViews?: () => Promise<LedgerView[]> }) | null
  ledgerPanel?: ReactNode
  settings: ReactNode
}

type View = 'hall' | 'invite' | 'storefront' | 'ledger' | 'settings' | 'retention' | 'reidentify' | 'stats' | 'mirror'

interface Totals { currency: string; balance: number; income: number; charge: number; ready: boolean }

function monthKey(time: string): string {
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${date.getMonth()}` : ''
}

export function totalsOf(views: readonly LedgerView[], now: Date): Totals {
  const currentMonth = `${now.getFullYear()}-${now.getMonth()}`
  let balance = 0, income = 0, charge = 0, currency = ''
  let ready = false
  for (const view of views) {
    if (typeof view.balance === 'number') { balance += view.balance; ready = true }
    for (const event of view.ledger.events) {
      try {
        const fields = parseChainFields(event)
        if (fields.currency) currency = fields.currency
        if (monthKey(fields.at) !== currentMonth) continue
        if (typeof fields.amount !== 'number') continue
        if (fields.type === 'topup' || fields.type === 'gift') income += fields.amount
        if (fields.type === 'charge') charge += fields.amount
      } catch { /* 单条坏记录不影响总览 */ }
    }
  }
  return { currency: currency || 'CNY', balance, income, charge, ready }
}

export function TeacherManagement({ identity, store, llm, gateway, send, ledger, settings }: TeacherManagementProps) {
  const [view, setView] = useState<View>('hall')
  const [own, setOwn] = useState<Storefront | null>(null)
  const [totals, setTotals] = useState<Totals | null>(null)

  useEffect(() => {
    let active = true
    const refresh = () => {
      void loadOwnStorefront(store, identity).then(value => {
        if (!active) return
        setOwn(value.current ? verifyStorefrontEvent(value.current, identity.publicKey)?.storefront ?? null : null)
      }).catch(() => {})
      if (ledger?.mergedViews) {
        void ledger.mergedViews().then(views => { if (active) setTotals(totalsOf(views, new Date())) }).catch(() => { if (active) setTotals(null) })
      }
    }
    refresh()
    window.addEventListener('aster:data-changed', refresh)
    return () => { active = false; window.removeEventListener('aster:data-changed', refresh) }
  }, [store, identity, ledger])

  if (view === 'invite') return <SubPage title="邀请学生" onBack={() => setView('hall')}>
    <p className="nl-quiet">第 2 位及以后的学生；邀请 7 天内有效，可邀请多位。</p>
    <InviteSettings identity={identity} gateway={gateway} store={store} />
  </SubPage>
  if (view === 'storefront') return <SubPage title="我的门面" onBack={() => setView('hall')}>
    <StorefrontSettings identity={identity} store={store} llm={llm} send={send} compact />
  </SubPage>
  if (view === 'ledger') return <SubPage title="钱账明细" onBack={() => setView('hall')}>
    <LedgerSettings managed flat identity={identity} store={store} ledger={ledger as never} />
  </SubPage>
  if (view === 'retention') return <SubPage title="记录保留多久" onBack={() => setView('settings')}>
    <RetentionSettings identity={identity} store={store} send={send} compact />
  </SubPage>
  if (view === 'reidentify') return <SubPage title="换手机" onBack={() => setView('settings')}>
    <TeacherReidentifyInbox store={store} teacher={identity.publicKey} ledger={ledger as never} send={send} />
    <ReidentifyLinks identity={identity} store={store} gateway={gateway} />
  </SubPage>
  if (view === 'stats') return <SubPage title="向社区分享运行统计" onBack={() => setView('settings')}>
    <StatsSharing store={store} />
  </SubPage>
  if (view === 'mirror') return <SubPage title="我的镜子" onBack={() => setView('settings')}>
    <DailyMirrorCard store={store} llm={llm} teacher={identity.publicKey} />
    <details className="nl-section"><summary>给自己定制调养方案</summary>
      <TeacherCarePlan identity={identity} store={store} student={identity.publicKey} llm={llm} />
    </details>
  </SubPage>
  if (view === 'settings') return <SubPage title="设置" onBack={() => setView('hall')}>
    <ul className="hall-list">
      <li><button type="button" className="nl-row" onClick={() => setView('retention')}><span className="nl-row-main"><strong>记录保留多久</strong><span>记录按设定天数滚动删除</span></span><span className="ts-chevron">›</span></button></li>
      <li><button type="button" className="nl-row" onClick={() => setView('reidentify')}><span className="nl-row-main"><strong>换手机</strong><span>生成认回链接、处理待认回请求</span></span><span className="ts-chevron">›</span></button></li>
      <li><button type="button" className="nl-row" onClick={() => setView('stats')}><span className="nl-row-main"><strong>向社区分享运行统计</strong><span>只发计数、时长和错误类型</span></span><span className="ts-chevron">›</span></button></li>
      <li><button type="button" className="nl-row" onClick={() => setView('mirror')}><span className="nl-row-main"><strong>我的镜子</strong><span>给自己的建议与调养方案</span></span><span className="ts-chevron">›</span></button></li>
    </ul>
    <details className="nl-section"><summary>模型与偏好设置</summary>
      {settings}
    </details>
  </SubPage>

  const theme = themeOf(own)
  return <main className="nl-page nl-manage">
    <div className="nl-top"><small>{own?.displayName ? own.displayName + '老师' : '我的馆'}</small></div>
    <h1>我的馆</h1>
    <section className="hall-card" aria-label="我的馆" style={{ ['--hall-accent' as string]: theme.primary }}>
      <span className="hall-emblem" style={{ background: theme.background }}><VenueEmblem emblem={own?.emblem ?? ''} /></span>
      <span className="nl-row-main">
        <strong>{own?.name || '还没有馆名'}</strong>
        <span>{own?.intro || '门面还没填介绍'}</span>
      </span>
      <span className="ts-badge ok">已开馆</span>
    </section>
    <button type="button" className="nl-primary hall-invite" onClick={() => setView('invite')}>＋ 邀请学生</button>
    <button type="button" className="nl-row hall-row" onClick={() => setView('storefront')}>
      <span className="nl-row-main"><strong>门面</strong><span>馆名、颜色、介绍和话术</span></span>
      <span className="ts-chevron">›</span>
    </button>

    <section aria-label="钱账总览">
      <div className="nl-top"><h2>钱账总览</h2><button type="button" className="nl-link-button ts-all" onClick={() => setView('ledger')}>看明细 ›</button></div>
      <div className="nl-card hall-ledger">
        <div className="hall-ledger-top"><span className="nl-quiet">学生预存余额合计</span><span className="nl-quiet">{totals?.currency ?? 'CNY'}</span></div>
        <strong className="hall-balance">{totals?.ready ? formatMoney(totals.balance, totals.currency) : '还没记过账'}</strong>
        <div className="hall-ledger-months">
          <div><span className="nl-quiet">本月确认收款</span><strong>{totals?.ready ? formatMoney(totals.income, totals.currency) : '—'}</strong></div>
          <div><span className="nl-quiet">本月已扣费</span><strong>{totals?.ready ? formatMoney(totals.charge, totals.currency) : '—'}</strong></div>
        </div>
      </div>
    </section>

    <button type="button" className="nl-row hall-row" onClick={() => setView('settings')}>
      <span className="nl-row-main"><strong>设置</strong><span>保留期限、换手机、运行统计、模型</span></span>
      <span className="ts-chevron">›</span>
    </button>
  </main>
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
