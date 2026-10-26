import { useEffect, useRef, useState } from 'react'
import { toDataURL } from 'qrcode'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { SendEnvelope } from './core/inbox'
import type { Event } from 'nostr-tools/pure'
import {
  connectionError, normalizeModel, providers, savePersonalModel, testConnection,
  type ModelGateway, type PersonalModel,
} from './core/llm/personal'
import { onboardingRequest, normalizeSetupToken } from './core/onboarding'
import { registerRecommendedTeacher } from './core/teacher-invites'
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
import { StorefrontWelcome, VenueEmblem } from './StorefrontWelcome'
import './newui.css'
import './newui2.css'
import { HallGroundwork } from './HallGroundwork'

// V2-17 建馆五步（05a–05e）：逻辑沿用 V2-15（断点续走、第一位学生 1 小时邀请、“先进去看看”），
// 只换界面：模型 → 登记 → 起馆名 → 开馆 → 邀请第一位学生。
export interface OpeningGuideProps {
  identity: Identity
  store: LocalStore
  send?: SendEnvelope
  gateway: string
  modelGateway: ModelGateway | null
  modelConfig: PersonalModel | null | undefined
  onModelSaved: (model: PersonalModel) => void
  onDone: () => void
  setupToken?: string
  coreSeedToken?: string
  teacherRecommendation?: Event | null
  onRegistrationComplete?: () => void
}

// V2-28：给选择而不是让人查文档；选了自动填好接口地址与模型名（“其他”才需要自己填）。
const GUIDE_PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'kimi', label: 'Kimi' },
  { id: 'qwen', label: '千问' },
  { id: 'other', label: '其他' },
] as const
type GuideProvider = (typeof GUIDE_PROVIDERS)[number]['id']

function providerDefaults(id: GuideProvider) {
  const found = providers.find(item => item.id === id) ?? providers.find(item => item.id === 'other')!
  return { baseUrl: found.baseUrl, model: found.model, endpointId: found.endpointId }
}

function clockLabel(at: number): string {
  const date = new Date(at)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

export function OpeningGuide({ identity, store, gateway, send, modelGateway, modelConfig, onModelSaved, onDone, setupToken='', coreSeedToken='', teacherRecommendation=null, onRegistrationComplete }: OpeningGuideProps) {
  const [loaded, setLoaded] = useState(false)
  const [step, setStep] = useState<GuideStep>(1)
  // 本次引导里刚测通的模型；上层 modelConfig 可能还没刷新，第 2、4 步的提示以两者任一为准。
  const [modelSaved, setModelSaved] = useState(false)
  const hasModel = !!modelConfig || modelSaved
  // V2-31/V2-37：一次性登记口令由外层在启动时取出并清理 URL fragment。
  const [token, setToken] = useState(setupToken)
  const [displayName, setDisplayName] = useState('')
  const [draft, setDraft] = useState<Storefront>(DEFAULT_STOREFRONT)
  const [invite, setInvite] = useState<GuideInvite | null>(null)
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [provider, setProvider] = useState<GuideProvider>('deepseek')
  const [baseUrl, setBaseUrl] = useState(providerDefaults('deepseek').baseUrl)
  const [model, setModel] = useState(providerDefaults('deepseek').model)
  const [apiKey, setApiKey] = useState('')
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState('')
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
      setDisplayName(savedDraft?.displayName ?? '')
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

  // 第 5 步：开馆后立刻生成 1 小时邀请；过期后只提示，等老师点“重新生成邀请”。
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

  useEffect(() => {
    let active = true
    if (step !== 5 || !invite || expired) { setQr(''); return }
    void toDataURL(invite.link, { width: 480, errorCorrectionLevel: 'L' }).then(value => { if (active) setQr(value) }).catch(() => { if (active) setQr('') })
    return () => { active = false }
  }, [step, invite, expired])

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

  const connectModel = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const defaults = providerDefaults(provider)
      const selected = providers.find(item => item.id === provider)
      if (selected?.endpointId) throw new Error('请先把接入点 ID 填在“接口地址”里')
      const config = normalizeModel({ provider, baseUrl: provider === 'other' || selected?.endpointId ? baseUrl : defaults.baseUrl, model, apiKey, testedAt: '' })
      if (config.apiKey === '') throw new Error('先填模型账户密钥')
      await testConnection(config, modelGateway)
      const saved = { ...config, testedAt: new Date().toISOString() }
      await savePersonalModel(store, saved)
      onModelSaved(saved)
      setModelSaved(true)
      await persist(2)
    } catch (cause) {
      setError(cause instanceof Error && cause.message === '先填模型账户密钥' ? '先填模型账户密钥' : connectionError(cause))
    } finally { setBusy(false) }
  }

  const register = async () => {
    if (busy) return
    const name = displayName.trim()
    if (name === '') { setError('先填一个学生认得的称呼。'); return }
    if (name.length > STOREFRONT_LIMITS.displayName) { setError(`称呼最多 ${STOREFRONT_LIMITS.displayName} 个字。`); return }
    const code = normalizeSetupToken(token)
    if (!teacherRecommendation&&!coreSeedToken&&code === '') { setError('先粘贴登记口令。'); return }
    setBusy(true); setError('')
    try {
      if(teacherRecommendation)await registerRecommendedTeacher(identity,gateway,teacherRecommendation)
      else if(coreSeedToken)await onboardingRequest(identity,gateway+'/invite/core-seed',{token:coreSeedToken})
      else await onboardingRequest(identity, gateway + '/invite/seed', { token: code })
      setToken('')
      history.replaceState(null,'',location.pathname+location.search)
      onRegistrationComplete?.()
      await saveStorefrontDraft(store, { ...draft, displayName: name } as Storefront)
      setDraft(current => ({ ...current, displayName: name }))
      await persist(3)
    } catch { setError('登记未成功，请核对口令，或联系部署者。') } finally { setBusy(false) }
  }

  const saveDraft = () => { void saveStorefrontDraft(store, normalizeStorefront(draft) ?? draft).catch(() => {}) }
  const update = (patch: Partial<Storefront>) => { setDraft(current => ({ ...current, ...patch })); setError('') }
  const nextFromVenue = async () => {
    const clean = normalizeStorefront({ ...draft, displayName: displayName.trim() })
    if (!clean || clean.name === '') { setError('先给馆起个名字。'); return }
    setBusy(true); setError('')
    try {
      await saveStorefrontDraft(store, clean)
      setDraft(clean)
      await persist(4)
    } catch { setError('馆名没有保存成功，请重试。') } finally { setBusy(false) }
  }

  const openHall = async () => {
    const clean = normalizeStorefront({ ...draft, displayName: displayName.trim() })
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
    setBusy(true); setError(''); setCopied('')
    try {
      const next = await createFirstInvite({ identity, store, base: location.href, gateway })
      setInvite(next); setExpired(false)
      await saveGuide(store, { step: 5, firstInvite: next })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '邀请暂时无法生成，请重试。') } finally { setBusy(false) }
  }

  const copy = () => {
    if (!invite) return
    void navigator.clipboard?.writeText(invite.link).then(() => setCopied('邀请已复制，可以发给学生。')).catch(() => setCopied('请长按邀请链接复制。'))
  }

  if (!loaded) return <main className="op-page"><p className="nl-quiet">正在准备建馆…</p></main>

  const stepBack = (next: GuideStep) => { setError(''); void go(next) }
  const canBack = !busy && (step > 1 || step === 1)
  const header = <header className="op-head">
    {step > 1 && step !== 5 ? <button type="button" className="op-back" aria-label="返回上一步" disabled={!canBack} onClick={() => stepBack((step - 1) as GuideStep)}>‹</button> : <span className="op-back-placeholder" />}
    <span className="op-step-label">建馆 · 第 {step} / 5 步</span>
  </header>
  const progress = <div className="op-progress" aria-hidden="true">{([1, 2, 3, 4, 5] as GuideStep[]).map(item => <span key={item} className={item <= step ? 'op-progress-seg done' : 'op-progress-seg'} />)}</div>
  const errorLine = error && <p role="alert" className="nl-danger-strong op-error">{error}</p>

  if (step === 1) {
    const selected = providers.find(item => item.id === provider)
    return <main className="op-page">
      {header}{progress}
      {errorLine}
      <section aria-label="接入自己的模型">
        <p className="op-eyebrow">先认识您的智能体</p>
        <h1 className="op-title">让它帮您打理馆</h1>
        <p className="op-desc">有自己的模型可以现在接上；<br />也可以开馆后再接。签字始终由您来。</p>
        <div className="op-card">
          <div className="op-card-head"><h2>选择模型</h2><span className="op-chip-soft">可随时更换</span></div>
          <div className="op-providers" role="group" aria-label="选择服务商">
            {GUIDE_PROVIDERS.map(item => <button type="button" key={item.id} aria-pressed={provider === item.id} className="op-provider" onClick={() => { setProvider(item.id); const defaults = providerDefaults(item.id); setBaseUrl(defaults.baseUrl); setModel(defaults.model); setApiKey(''); setError('') }}>{item.label}</button>)}
          </div>
          <label>模型账户密钥<input type="password" autoComplete="off" disabled={busy} value={apiKey} placeholder="粘贴模型账户密钥" onChange={event => { setApiKey(event.target.value); setError('') }} /></label>
          {provider === 'other' && <>
            <label>接口地址<input disabled={busy} value={baseUrl} placeholder="https://…/v1" onChange={event => setBaseUrl(event.target.value)} /></label>
            <label>模型名称<input disabled={busy} value={model} placeholder="模型名称" onChange={event => setModel(event.target.value)} /></label>
          </>}
          {provider !== 'other' && <p className="op-card-note">接口地址：{providerDefaults(provider).baseUrl}<br />模型名称：{providerDefaults(provider).model}（已自动填好）</p>}
          {selected?.docs && <p className="op-link-row"><a href={'/help/' + provider + '.html'} target="_blank" rel="noopener noreferrer">没有账户？查看接入方法 ›</a></p>}
        </div>
        <div className="op-hint"><span className="op-hint-icon" aria-hidden="true"><VenueEmblem emblem="leaf" /></span><span>接入后，会先试一句话，<br />看看能不能正常回答。</span></div>
      </section>
      <footer className="op-foot"><button type="button" className="nl-primary" disabled={busy} onClick={() => void connectModel()}>测试并继续</button><button type="button" className="op-link-button" disabled={busy} onClick={() => void go(2)}>先跳过，以后接模型</button></footer>
    </main>
  }

  if (step === 2) {
    return <main className="op-page">
      {header}{progress}
      {errorLine}
      <section aria-label="登记为社区老师">
        <p className="op-eyebrow">{hasModel ? '模型已接好 ✓' : '模型以后再接'}</p>
        <h1 className="op-title">先登记您这位老师</h1>
        <p className="op-desc">填一个学生认得的称呼。<br />登记好，就可以起馆名了。</p>
        <div className="op-card">
          <label>学生怎么称呼您<input value={displayName} maxLength={STOREFRONT_LIMITS.displayName} disabled={busy} placeholder="例如：阿慈老师" onChange={event => { setDisplayName(event.target.value); setError('') }} /></label>
          {teacherRecommendation ? <p className="op-card-note">一位核心成员推荐您加入知衡。登记链接只能使用一次，7 天内有效。</p> : coreSeedToken ? <p className="op-card-note">您正在登记为知衡核心成员。此链接只能由发起人使用一次。</p> : <>
            <label>登记口令<input type="password" autoComplete="off" disabled={busy} value={token} placeholder="粘贴收到的登记口令（空格和换行会自动去掉）" onChange={event => { setToken(normalizeSetupToken(event.target.value)); setError('') }} /></label>
            <p className="op-card-note">在部署电脑上打开 <code>data/setup/teacher-setup.html</code>，用这部手机扫码，口令会自动填好。</p>
            <p className="op-card-note">也可以手动粘贴：口令在部署电脑的 <code>data/setup/teacher-setup-code.txt</code>。</p>
            <p className="op-card-note">这是一次性登记口令，登记成功后会自动作废。</p>
            <p className="op-card-note">还没有核心成员时，部署口令仍可作为首次老师登记的兜底。</p>
          </>}
        </div>
        <div className="op-note-card">
          <strong>只登记这一次</strong>
          <p>以后打开就是您的馆。馆名、介绍，都可以在开馆后慢慢改。</p>
        </div>
        {!gateway && <p role="alert" className="nl-danger-strong">还没有配置社区网关，暂时不能登记。</p>}
      </section>
      <footer className="op-foot"><button type="button" className="nl-primary" disabled={busy || (!teacherRecommendation&&!coreSeedToken&&token.trim() === '') || displayName.trim() === '' || !gateway} onClick={() => void register()}>登记，下一步</button></footer>
    </main>
  }

  if (step === 3) {
    return <main className="op-page">
      {header}{progress}
      {errorLine}
      <section aria-label="给馆起名">
        <h1 className="op-title">给您的馆起个名</h1>
        <p className="op-desc">学生打开邀请，先看到这里。</p>
        <label>馆名<input value={draft.name} maxLength={STOREFRONT_LIMITS.name} placeholder="例如：阿慈养生馆" onChange={event => update({ name: event.target.value })} onBlur={saveDraft} /></label>
        <label>一句介绍<textarea rows={3} maxLength={STOREFRONT_LIMITS.intro} value={draft.intro} placeholder="一起照顾日常作息，慢慢练成适合自己的习惯。" onChange={event => update({ intro: event.target.value })} onBlur={saveDraft} /></label>
        <div className="op-color-row">
          <span>馆的颜色</span>
          <div className="op-colors" role="group" aria-label="馆的颜色">
            {THEMES.map((theme: StorefrontTheme) => <button type="button" key={theme} aria-pressed={draft.theme === theme} className={'op-color op-theme-' + theme} onClick={() => { update({ theme }); saveDraft() }}><span aria-hidden="true" />{STOREFRONT_THEMES[theme].label}</button>)}
          </div>
        </div>
        <p className="op-preview-label">学生看到的样子</p>
        <div className="op-preview"><StorefrontWelcome storefront={{ ...draft, displayName: displayName || draft.displayName }} teacher={identity.publicKey} preview compact /></div>
      </section>
      <footer className="op-foot"><button type="button" className="nl-primary" disabled={busy} onClick={() => void nextFromVenue()}>就用这个名字</button></footer>
    </main>
  }

  if (step === 4) {
    return <main className="op-page">
      {header}{progress}
      {errorLine}
      <section className="op-open op-ground-open" aria-label="开馆">
        <span className="op-open-emblem"><VenueEmblem emblem={draft.emblem} /></span>
        <p className="nl-quiet">您的馆准备好了</p>
        <h1 className="op-title op-open-name">{draft.name || '还没有馆名'}</h1>
        <p className="nl-quiet">{displayName || draft.displayName || '还没有称呼'}老师</p>
        <div className="op-card op-open-card">
          {draft.intro && <p>{draft.intro}</p>}
          <ul className="op-checks">
            <li>{hasModel ? '✓ 模型已接好' : '模型还没设，可以以后补'}</li>
            <li>✓ 老师已登记</li>
            <li>✓ 门面已备好</li>
          </ul>
        </div>
        <p className="nl-quiet op-open-note">下面的基础工作可以以后补；现在也能开馆、邀请学生。</p>
      </section>
      <HallGroundwork store={store} identity={identity} send={send} />
      <footer className="op-foot ground-footer"><button type="button" className="nl-primary" disabled={busy} onClick={() => void openHall()}>开馆</button></footer>
    </main>
  }

  return <main className="op-page">
    {header}{progress}
    {errorLine}
    <section aria-label="邀请第一位学生">
      <p className="op-eyebrow">{draft.name || '我的馆'} · 已开馆</p>
      <h1 className="op-title">请第一位学生进来</h1>
      <p className="op-desc">把邀请发给他，或让他当面扫码。</p>
      <div className="op-card op-invite">
        <p className="op-invite-title">{displayName || draft.displayName || '老师'}老师的邀请</p>
        {qr ? <img className="op-qr" src={qr} width={240} height={240} alt="学生扫码即可加入" /> : expired ? <p className="op-qr-missing">邀请已过期</p> : <p className="nl-quiet">正在生成二维码…</p>}
        <p className="nl-quiet">二维码示意</p>
        {!expired && <span className="op-badge">这份邀请 1 小时有效</span>}
        {invite && <p className="nl-quiet">{expired ? '邀请已过期' : `有效至今天 ${clockLabel(invite.expiresAt)}`}</p>}
        {expired
          ? <button type="button" className="nl-primary op-regenerate" disabled={busy} onClick={() => void regenerate()}>重新生成邀请</button>
          : <button type="button" className="op-link-button" disabled={busy} onClick={() => void regenerate()}>重新生成邀请 ›</button>}
        <details className="op-link-details"><summary>邀请链接</summary>
          <label>邀请链接<input readOnly aria-label="邀请链接" value={invite?.link ?? ''} /></label>
          <button type="button" onClick={copy}>复制邀请</button>
          {copied && <p role="status">{copied}</p>}
        </details>
      </div>
      <div className="op-hint"><span className="op-hint-icon" aria-hidden="true">👥</span><span>学生自己接入模型、照镜子、问诊。<br />您在“今天”等他就好。</span></div>
    </section>
    <footer className="op-foot">
      <button type="button" className="nl-primary" disabled={busy || expired || !invite} onClick={copy}>复制邀请，发给学生</button>
      <button type="button" className="op-link-button" disabled={busy} onClick={() => void finish()}>先进去看看</button>
    </footer>
  </main>
}
