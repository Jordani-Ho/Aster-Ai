import { useEffect, useRef, useState } from 'react'
import { ModelSettings } from './ModelSettings'
import { InviteTicket } from './InviteTicket'
import { StorefrontWelcome } from './StorefrontWelcome'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { PersonalModel, ModelGateway } from './core/llm/personal'
import { onboardingRequest } from './core/onboarding'
import {
  DEFAULT_STOREFRONT, STOREFRONT_LIMITS, STOREFRONT_THEMES, THEMES,
  normalizeStorefront, publishStorefront, saveStorefrontDraft,
  loadStorefrontDraft, type Storefront, type StorefrontTheme,
} from './core/storefront'
import {
  completeHall, createFirstInvite, guideInviteExpired, hasFirstStudent,
  loadGuide, loadHall, markHallOpened, saveGuide,
  type GuideInvite, type GuideState, type GuideStep,
} from './core/hall'
import './opening.css'

// V2-15 建馆引导：一屏一步；进度只存本机，关掉再打开从同一屏继续。
// 开馆 = 本机状态 + 门面签发；第一位学生的邀请 1 小时内有效，学生加入后进入正常首页。
export interface OpeningGuideProps {
  identity: Identity
  store: LocalStore
  gateway: string
  modelGateway: ModelGateway | null
  modelConfig: PersonalModel | null | undefined
  onModelSaved: (model: PersonalModel) => void
  onDone: () => void
}

export function OpeningGuide({ identity, store, gateway, modelGateway, modelConfig, onModelSaved, onDone }: OpeningGuideProps) {
  const [loaded, setLoaded] = useState(false)
  const [step, setStep] = useState<GuideStep>(1)
  const [token, setToken] = useState('')
  const [draft, setDraft] = useState<Storefront>(DEFAULT_STOREFRONT)
  const [invite, setInvite] = useState<GuideInvite | null>(null)
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const finishing = useRef(false)

  // 读回进度：已开馆但还没送走第一位学生的，直接回到第 5 步；已完成的直接进首页。
  useEffect(() => {
    let active = true
    void (async () => {
      const [saved, hall, savedDraft] = await Promise.all([loadGuide(store), loadHall(store), loadStorefrontDraft(store)])
      if (!active) return
      if (hall?.completedAt) { onDone(); return }
      const next: GuideState = hall ? { ...saved, step: 5 } : saved
      setStep(next.step)
      setInvite(next.firstInvite)
      setDraft(savedDraft ?? DEFAULT_STOREFRONT)
      setLoaded(true)
    })().catch(() => { if (active) { setError('建馆引导读取失败，请重试。'); setLoaded(true) } })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  const persist = async (nextStep: GuideStep, firstInvite: GuideInvite | null = invite) => {
    const saved = await saveGuide(store, { step: nextStep, firstInvite })
    setStep(saved.step)
    setInvite(saved.firstInvite)
  }

  const go = async (nextStep: GuideStep) => {
    setError(''); setBusy(true)
    try { await persist(nextStep) } catch { setError('进度没有保存成功，请重试。') } finally { setBusy(false) }
  }

  // 模型已经在别的入口接好时，不重复停在第一步。
  useEffect(() => {
    if (!loaded || step !== 1 || !modelConfig) return
    void go(2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, step, modelConfig])

  // 第 5 步：开馆后立刻生成 1 小时邀请；过期后只提示，等老师点“重新生成”。
  useEffect(() => {
    if (!loaded || step !== 5) return
    let active = true
    setExpired(invite ? guideInviteExpired(invite) : false)
    if (!invite) {
      void createFirstInvite({ identity, store, base: location.href, gateway })
        .then(next => { if (!active) return; setInvite(next); setExpired(false); return saveGuide(store, { step: 5, firstInvite: next }) })
        .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '邀请暂时无法生成，请重试。') })
    }
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, step, invite])

  useEffect(() => {
    if (step !== 5 || !invite) return
    const tick = () => setExpired(guideInviteExpired(invite))
    tick()
    const timer = setInterval(tick, 15_000)
    return () => clearInterval(timer)
  }, [step, invite])

  const finish = async () => {
    if (finishing.current) return
    finishing.current = true
    try { await completeHall(store) } catch { /* 状态写失败也先进入首页，学生已经加入。 */ }
    onDone()
  }
  useEffect(() => {
    if (step !== 5) return
    let active = true
    const check = () => { void hasFirstStudent(store).then(found => { if (active && found) void finish() }).catch(() => {}) }
    check()
    window.addEventListener('aster:data-changed', check)
    const timer = setInterval(check, 5_000)
    return () => { active = false; window.removeEventListener('aster:data-changed', check); clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, store])

  if (!loaded) return <main className="opening-guide"><p>正在准备建馆…</p></main>

  const register = async () => {
    if (busy || token.trim() === '') return
    setBusy(true); setError('')
    try {
      await onboardingRequest(identity, gateway + '/invite/seed', { token: token.trim() })
      setToken('')
      await persist(3)
    } catch { setError('登记未成功，请核对口令，或联系部署者。') } finally { setBusy(false) }
  }

  const saveDraft = () => { void saveStorefrontDraft(store, normalizeStorefront(draft) ?? draft).catch(() => {}) }
  const update = (patch: Partial<Storefront>) => { setDraft(current => ({ ...current, ...patch })); setError('') }
  const nextFromVenue = async () => {
    const clean = normalizeStorefront(draft)
    if (!clean || clean.name === '' || clean.displayName === '') { setError('先填馆名和学生怎么称呼您，学生才知道这是谁。'); return }
    setBusy(true); setError('')
    try {
      await saveStorefrontDraft(store, clean)
      setDraft(clean)
      await persist(4)
    } catch { setError('馆名没有保存成功，请重试。') } finally { setBusy(false) }
  }

  const openHall = async () => {
    const clean = normalizeStorefront(draft)
    if (!clean || clean.name === '' || clean.displayName === '') { setError('门面还没填完整，请返回上一步。'); return }
    setBusy(true); setError('')
    try {
      await publishStorefront({ store, identity, storefront: clean })
      await saveStorefrontDraft(store, clean)
      await markHallOpened(store)
      await persist(5, null)
    } catch { setError('开馆没有完成，请重试。') } finally { setBusy(false) }
  }

  const regenerate = async () => {
    setBusy(true); setError('')
    try {
      const next = await createFirstInvite({ identity, store, base: location.href, gateway })
      setInvite(next); setExpired(false)
      await saveGuide(store, { step: 5, firstInvite: next })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '邀请暂时无法生成，请重试。') } finally { setBusy(false) }
  }

  return <main className="opening-guide">
    <header className="opening-head">
      <p className="opening-eyebrow">知衡 · 建馆</p>
      <p className="opening-progress" role="status">第 {step} 步，共 5 步</p>
    </header>
    {error && <p role="alert" className="opening-error">{error}</p>}

    {step === 1 && <section className="opening-step" aria-label="接入自己的模型">
      <h1>接入自己的模型</h1>
      <p>开馆后，起草病历、整理钱账都用您自己的模型账户。费用由自己的账户承担。</p>
      {modelConfig === undefined ? <p>正在读取接入设置…</p> : <ModelSettings initial store={store} gateway={modelGateway} current={modelConfig} submitLabel="下一步" onSaved={model => { onModelSaved(model); void persist(2) }} />}
    </section>}

    {step === 2 && <>
      <section className="opening-step" aria-label="登记为社区老师">
        <h1>登记为社区老师</h1>
        <p>第一次建立社区时，输入部署电脑提供的一次性口令。登记后，这座馆才能邀请学生。</p>
        <label>部署口令<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label>
        <p className="opening-note">口令在部署电脑上：deploy/home/data/teacher-setup-code.txt。</p>
        {!gateway && <p role="alert" className="opening-error">还没有配置社区网关，暂时不能登记。</p>}
      </section>
      <div className="opening-actions">
        <button disabled={busy} onClick={() => void go(1)}>返回</button>
        <button className="opening-primary" disabled={busy || token.trim() === '' || !gateway} onClick={() => void register()}>登记为社区老师</button>
      </div>
    </>}

    {step === 3 && <>
      <section className="opening-step" aria-label="给馆起名">
        <h1>给馆起名</h1>
        <p>学生打开邀请会先看到这里。先填馆名和称呼，下面就是学生看到的样子。</p>
        <label>馆名<input value={draft.name} maxLength={STOREFRONT_LIMITS.name} placeholder="例如：阿慈养生馆" onChange={event => update({ name: event.target.value })} onBlur={saveDraft} /></label>
        <label>学生怎么称呼您<input value={draft.displayName} maxLength={STOREFRONT_LIMITS.displayName} placeholder="例如：阿慈" onChange={event => update({ displayName: event.target.value })} onBlur={saveDraft} /></label>
        <label>主题<select aria-label="主题" value={draft.theme} onChange={event => { update({ theme: event.target.value as StorefrontTheme }); saveDraft() }}>
          {THEMES.map(theme => <option key={theme} value={theme}>{STOREFRONT_THEMES[theme].label}</option>)}
        </select></label>
        <label>短介绍（最多 {STOREFRONT_LIMITS.intro} 字）<textarea rows={3} maxLength={STOREFRONT_LIMITS.intro} value={draft.intro} placeholder="例如：一起照顾日常作息，慢慢练成适合自己的习惯。" onChange={event => update({ intro: event.target.value })} onBlur={saveDraft} /></label>
        <p className="opening-preview-label">学生看到的样子（预览）</p>
        <div className="storefront-preview"><StorefrontWelcome storefront={draft} teacher={identity.publicKey} preview /></div>
      </section>
      <div className="opening-actions">
        <button disabled={busy} onClick={() => void go(2)}>返回</button>
        <button className="opening-primary" disabled={busy} onClick={() => void nextFromVenue()}>下一步</button>
      </div>
    </>}

    {step === 4 && <>
      <section className="opening-step" aria-label="开馆">
        <h1>开馆</h1>
        <p>点“开馆”后，这座馆就正式开张：门面会签名生效，接着邀请第一位学生。</p>
        <p className="opening-venue">{draft.name || '还没有馆名'} · {draft.displayName || '还没有称呼'} · {STOREFRONT_THEMES[draft.theme].label}</p>
        {draft.intro && <p className="opening-intro">{draft.intro}</p>}
      </section>
      <div className="opening-actions">
        <button disabled={busy} onClick={() => void go(3)}>返回</button>
        <button className="opening-primary opening-open" disabled={busy} onClick={() => void openHall()}>开馆</button>
      </div>
    </>}

    {step === 5 && <>
      <section className="opening-step" aria-label="邀请第一位学生">
        <h1>邀请第一位学生</h1>
        <p>开馆了。请第一位学生用另一部手机扫码，或打开这个链接。这个邀请 1 小时内有效。</p>
        {invite ? <>
          <InviteTicket link={invite.link} note={expired ? '邀请已过期' : `有效到 ${new Date(invite.expiresAt).toLocaleTimeString()}`} />
          {expired && <div className="opening-actions">
            <button className="opening-primary" disabled={busy} onClick={() => void regenerate()}>重新生成</button>
          </div>}
        </> : error ? null : <p className="opening-note">正在生成邀请…</p>}
        <p className="opening-note">学生加入后会自动连上社区；老师这边会自动进入首页。</p>
        {/* V2-13：第一位学生迟迟没连上时，老师可以直接进工作台；以后还能在管理页邀请。 */}
        <div className="opening-actions">
          <button type="button" className="opening-skip" disabled={busy} onClick={() => void finish()}>先进去看看</button>
        </div>
        <p className="opening-note">不急的话，也可以以后在「管理 → 邀请学生」继续邀请。</p>
      </section>
    </>}
  </main>
}
