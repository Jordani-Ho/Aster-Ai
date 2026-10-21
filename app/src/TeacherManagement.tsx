import type { ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { SendEnvelope } from './core/inbox'
import { InviteSettings } from './InviteSettings'
import { StorefrontSettings } from './StorefrontSettings'
import { RetentionSettings } from './RetentionSettings'
import { ReidentifyLinks } from './ReidentifyPages'
import { StatsSharing } from './StatsSharing'

export interface TeacherManagementProps {
  identity: Identity
  store: LocalStore
  llm: LlmClient | null
  gateway: string
  send?: SendEnvelope
  ledgerPanel: ReactNode
  settings: ReactNode
}

// V2-15 管理页：开馆后按顺序分块，每块一个标题、默认折叠；每个功能只出现一处。
// 登记社区老师已进建馆引导；舌象级别、模板、模型等收在最后的“设置”里。
export function TeacherManagement({ identity, store, llm, gateway, send, ledgerPanel, settings }: TeacherManagementProps) {
  return <main className="teacher-manage">
    <h1>管理</h1>
    <p className="inbox-note">开馆后按功能分块，点标题展开。</p>
    <details className="teacher-card manage-block" aria-label="邀请学生">
      <summary>邀请学生</summary>
      <p className="inbox-note">第 2 位及以后的学生；邀请 7 天内有效，可邀请多位。</p>
      <InviteSettings identity={identity} gateway={gateway} store={store} />
    </details>
    <details className="teacher-card manage-block" aria-label="我的门面">
      <summary>我的门面</summary>
      <StorefrontSettings identity={identity} store={store} llm={llm} send={send} compact />
    </details>
    <details className="teacher-card manage-block" aria-label="钱账">
      <summary>钱账</summary>
      {ledgerPanel}
    </details>
    <details className="teacher-card manage-block" aria-label="记录保留多久">
      <summary>记录保留多久</summary>
      <RetentionSettings identity={identity} store={store} send={send} compact />
    </details>
    <details className="teacher-card manage-block" aria-label="换手机">
      <summary>换手机</summary>
      <ReidentifyLinks identity={identity} store={store} gateway={gateway} />
    </details>
    <details className="teacher-card manage-block" aria-label="向社区分享运行统计">
      <summary>向社区分享运行统计</summary>
      <StatsSharing store={store} />
    </details>
    {settings}
  </main>
}
