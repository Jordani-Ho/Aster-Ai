import { useEffect, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { Envelope } from './core/transport'
import {
  DEFAULT_STOREFRONT, EMBLEMS, STOREFRONT_LIMITS, THEMES, STOREFRONT_THEMES,
  loadOwnStorefront, loadStorefrontDraft, normalizeStorefront, publishStorefront,
  restoreStorefront, saveStorefrontDraft, sendStorefrontTo, verifyStorefrontEvent,
  type Storefront, type StorefrontEmblem, type StorefrontTheme,
} from './core/storefront'
import { reviseStorefront } from './core/storefront/instruction'
import { teacherStudentCandidates } from './core/reidentify'
import { StorefrontWelcome } from './StorefrontWelcome'
import './storefront.css'

const EMBLEM_LABELS: Record<string, string> = { '': '不显示标志', leaf: '叶', sun: '日', heart: '心', dot: '圆点' }

export interface StorefrontSettingsProps {
  identity: Identity
  store: LocalStore
  llm: LlmClient | null
  send?: (recipient: string, envelope: Envelope) => Promise<unknown>
  /** V2-15：管理页“我的门面”块已有标题，不再重复标题与说明。 */
  compact?: boolean
}

// V2-09 老师“我的门面”：左边直接改，下边学生视角预览；点“用这个样子”才签名发布，
// 保留“恢复上次样子”（只存上一版）。门面保存不签健康内容、不记钱。
export function StorefrontSettings({ identity, store, llm, send, compact = false }: StorefrontSettingsProps) {
  const [draft, setDraft] = useState<Storefront>(DEFAULT_STOREFRONT)
  const [saved, setSaved] = useState<{ current: boolean; previous: Storefront | null }>({ current: false, previous: null })
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      const [own, savedDraft] = await Promise.all([loadOwnStorefront(store, identity), loadStorefrontDraft(store)])
      if (!active) return
      const current = own.current ? verifyStorefrontEvent(own.current, identity.publicKey)?.storefront ?? null : null
      const previous = own.previous ? verifyStorefrontEvent(own.previous, identity.publicKey)?.storefront ?? null : null
      setSaved({ current: current !== null, previous })
      setDraft(savedDraft ?? current ?? DEFAULT_STOREFRONT)
    })().catch(() => { if (active) setError('门面设置暂时无法读取，请稍后重试。') })
    return () => { active = false }
  }, [store, identity])

  const update = (patch: Partial<Storefront>) => {
    setDraft(current => normalizeStorefront({ ...current, ...patch }) ?? current)
    setNotice('')
  }

  const saveDraft = (next: Storefront) => { void saveStorefrontDraft(store, next).catch(() => {}) }

  const runInstruction = async () => {
    const text = instruction.trim()
    if (text === '' || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const change = await reviseStorefront({ current: draft, instruction: text, llm })
      if (!change.changed) { setError('这句话没改到门面配置，可以直接改上面几项，或换一种说法。'); return }
      setDraft(change.storefront)
      saveDraft(change.storefront)
      setInstruction('')
      setNotice(change.source === 'model' ? '已按您的话改好预览，还没生效。' : '已改好预览，还没生效。')
    } catch { setError('这次修改没成功，草稿保留，可以再试一次。') } finally { setBusy(false) }
  }

  const publish = async () => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const clean = normalizeStorefront(draft)
      if (!clean) { setError('门面内容超出长度或包含无效字符，请检查后重试。'); return }
      await publishStorefront({ store, identity, storefront: clean })
      await saveStorefrontDraft(store, clean)
      const own = await loadOwnStorefront(store, identity)
      setSaved({
        current: true,
        previous: own.previous ? verifyStorefrontEvent(own.previous, identity.publicKey)?.storefront ?? null : null,
      })
      // 发给已知学生；发送失败不影响已保存的门面，学生下次同步或打开邀请链接也能看到。
      let sent = 0
      if (send) {
        try {
          const students = (await teacherStudentCandidates(store)).map(candidate => candidate.student)
          sent = await sendStorefrontTo({ store, identity, recipients: students, send })
        } catch { sent = 0 }
      }
      setNotice(sent > 0 ? `已用这个样子，并通知了 ${sent} 位学生下次同步时看到。` : '已用这个样子，学生下次同步时会看到。')
    } catch { setError('门面没有保存成功，请重试。') } finally { setBusy(false) }
  }

  const restore = async () => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const restored = await restoreStorefront({ store, identity })
      if (!restored) { setError('还没有上一版可以恢复。'); return }
      setDraft(restored.storefront)
      saveDraft(restored.storefront)
      const own = await loadOwnStorefront(store, identity)
      setSaved({
        current: true,
        previous: own.previous ? verifyStorefrontEvent(own.previous, identity.publicKey)?.storefront ?? null : null,
      })
      let sent = 0
      if (send) {
        try {
          const students = (await teacherStudentCandidates(store)).map(candidate => candidate.student)
          sent = await sendStorefrontTo({ store, identity, recipients: students, send })
        } catch { sent = 0 }
      }
      setNotice(sent > 0 ? '已恢复上次样子，并通知学生下次同步时更新。' : '已恢复上次样子。')
    } catch { setError('恢复上次样子没有成功，请重试。') } finally { setBusy(false) }
  }

  return <section aria-label="我的门面">
    {compact ? null : <><h2>我的门面</h2>
    <p>学生打开您的邀请会先看到这里：馆名、标志、颜色和短介绍。改了先看预览，点“用这个样子”才生效。</p></>}
    <div className="storefront-form">
      <label>馆名<input value={draft.name} maxLength={STOREFRONT_LIMITS.name} placeholder="例如：阿慈养生馆" onChange={event => update({ name: event.target.value })} onBlur={() => saveDraft(draft)} /></label>
      <label>显示称呼<input value={draft.displayName} maxLength={STOREFRONT_LIMITS.displayName} placeholder="例如：阿慈" onChange={event => update({ displayName: event.target.value })} onBlur={() => saveDraft(draft)} /></label>
      <label>标志<select value={draft.emblem} onChange={event => { update({ emblem: event.target.value as StorefrontEmblem }); saveDraft({ ...draft, emblem: event.target.value as StorefrontEmblem }) }}>
        {EMBLEMS.map(emblem => <option key={emblem} value={emblem}>{EMBLEM_LABELS[emblem]}</option>)}
        <option value="">不显示标志</option>
      </select></label>
      <label>颜色<select value={draft.theme} onChange={event => { const theme = event.target.value as StorefrontTheme; update({ theme }); saveDraft({ ...draft, theme }) }}>
        {THEMES.map(theme => <option key={theme} value={theme}>{STOREFRONT_THEMES[theme].label}</option>)}
      </select></label>
      <label>短介绍（最多 {STOREFRONT_LIMITS.intro} 字）<textarea rows={3} maxLength={STOREFRONT_LIMITS.intro} value={draft.intro} placeholder="例如：一起照顾日常作息，慢慢练成适合自己的习惯。" onChange={event => update({ intro: event.target.value })} onBlur={() => saveDraft(draft)} /></label>
      <label>欢迎语（最多 {STOREFRONT_LIMITS.welcome} 字）<input maxLength={STOREFRONT_LIMITS.welcome} value={draft.welcome} placeholder="例如：从每天照镜子开始。" onChange={event => update({ welcome: event.target.value })} onBlur={() => saveDraft(draft)} /></label>
      <label>想改哪里？<input value={instruction} placeholder={llm ? '例如：馆名改成小黄运动馆，用蓝色' : '接入模型后可以用一句话改；也可以直接改上面几项'} disabled={busy} onChange={event => setInstruction(event.target.value)} /></label>
      <div className="storefront-actions">
        <button type="button" disabled={busy || instruction.trim() === ''} onClick={() => void runInstruction()}>让智能体改</button>
        <button type="button" disabled={busy} onClick={() => void publish()}>用这个样子</button>
        <button type="button" disabled={busy || !saved.previous} onClick={() => void restore()}>恢复上次样子</button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
    <p className="storefront-preview-label">学生看到的样子（预览）</p>
    <div className="storefront-preview" data-testid="storefront-preview">
      <StorefrontWelcome storefront={draft} teacher={identity.publicKey} preview />
    </div>
    {saved.current && <p role="status">当前已生效的门面可以继续改；改坏了可以点“恢复上次样子”。</p>}
  </section>
}
