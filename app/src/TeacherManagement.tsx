import type { ReactNode } from 'react'
import { useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { LedgerRecorder, SendEnvelope } from './core/inbox'
import { InviteSettings } from './InviteSettings'
import { StorefrontSettings } from './StorefrontSettings'
import { RetentionSettings } from './RetentionSettings'
import { ReidentifyLinks, TeacherReidentifyInbox } from './ReidentifyPages'
import { StatsSharing } from './StatsSharing'
import { DailyMirrorCard } from './DailyMirrorCard'
import { TeacherCarePlan } from './TeacherCarePlan'
import './newui.css'
import './inbox.css'

export interface TeacherManagementProps {
  identity: Identity
  store: LocalStore
  llm: LlmClient | null
  gateway: string
  send?: SendEnvelope
  ledger?: LedgerRecorder
  ledgerPanel: ReactNode
  settings: ReactNode
}

// V2-16 我的馆：V2-15 的管理页整体挪进来，按顺序分块、每块默认折叠。
// 换手机块里带上“待认回”提示（以前在今天的顶部）；我的镜子/给自己定制调养方案收在最后。
export function TeacherManagement({ identity, store, llm, gateway, send, ledger, ledgerPanel, settings }: TeacherManagementProps) {
  // “我的镜子”展开时才挂载，避免一进我的馆就为老师自己的建议调一次模型。
  const [mirrorOpen, setMirrorOpen] = useState(false)
  return <main className="nl-page nl-manage">
    <h1>我的馆</h1>
    <p className="nl-quiet">按功能分块，点标题展开。每个功能只出现一处。</p>
    <details className="manage-block" aria-label="邀请学生">
      <summary>邀请学生</summary>
      <p className="nl-quiet">第 2 位及以后的学生；邀请 7 天内有效，可邀请多位。</p>
      <InviteSettings identity={identity} gateway={gateway} store={store} />
    </details>
    <details className="manage-block" aria-label="我的门面">
      <summary>我的门面</summary>
      <StorefrontSettings identity={identity} store={store} llm={llm} send={send} compact />
    </details>
    <details className="manage-block" aria-label="钱账">
      <summary>钱账</summary>
      {ledgerPanel}
    </details>
    <details className="manage-block" aria-label="记录保留多久">
      <summary>记录保留多久</summary>
      <RetentionSettings identity={identity} store={store} send={send} compact />
    </details>
    <details className="manage-block" aria-label="换手机">
      <summary>换手机</summary>
      <TeacherReidentifyInbox store={store} teacher={identity.publicKey} ledger={ledger} send={send} />
      <ReidentifyLinks identity={identity} store={store} gateway={gateway} />
    </details>
    <details className="manage-block" aria-label="向社区分享运行统计">
      <summary>向社区分享运行统计</summary>
      <StatsSharing store={store} />
    </details>
    <details className="manage-block" aria-label="我的镜子" open={mirrorOpen}
      onToggle={event => { const open = event.currentTarget.open; setMirrorOpen(open) }}>
      <summary>我的镜子</summary>
      {mirrorOpen && <>
        <DailyMirrorCard store={store} llm={llm} teacher={identity.publicKey} />
        <details className="nl-section"><summary>给自己定制调养方案</summary>
          <TeacherCarePlan identity={identity} store={store} student={identity.publicKey} llm={llm} />
        </details>
      </>}
    </details>
    {settings}
  </main>
}
