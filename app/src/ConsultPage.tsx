import { useEffect, useState } from 'react'
import template from '../../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../../domain/tcm/templates/types'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { ConsultPackage, Encounter } from './core/record/types'
import {
  addTongue, addUtterance, answerFocus, canConfirm, confirmAndSend, INTAKE_COLLECTIONS,
  defaultHistorySelection, loadDraft, loadHistory, loadProfile, markReviewed,
  organizeSession, saveDraft, skipFocus, startSession, updateField,
  type IntakeKey, type IntakeSession,
} from './core/intake'
import { loadTeachers } from './core/inbox'
import { heavenNow, heavenStampOf, type HeavenTime } from './core/heaven'
import { createFamilyProof } from './core/family/proof'
import type { FamilyMember } from './core/family'
import { MemberSwitcher } from './MemberSwitcher'
import { listCheckins } from './core/homework'
import { listSelfRatings, listStressRatings, last14DayTrend } from './core/mirror/trend'
import { detectRegion, type RedFlagResult } from './core/redflags'
import { RedFlagAlert } from './RedFlagAlert'
import { uiError } from './core/onboarding/ui'
import { TongueCapture } from './TongueCapture'
import { TonguePair } from './TonguePair'
import { buildPeriodObservation } from './core/kangbi'
import './newui.css'
import './student.css'

const FIELD_LABELS: Record<IntakeKey, string> = {
  chiefComplaint: '最不舒服的地方（主诉）',
  presentIllness: '现在的情况（现病史）',
  history: '以前的病（既往史）',
  medsAllergies: '在吃的药、过敏',
}
const CARD_LABELS: Record<IntakeKey, string> = {
  chiefComplaint: '主诉',
  presentIllness: '现病史',
  history: '既往史',
  medsAllergies: '在用药',
}

function message(cause: unknown): string {
  return uiError(cause, '操作失败，请重试')
}

// 急症横幅只说学生自己提到的症状词：去掉持续时间词和互相包含的重复词，最多三个。
function matchedWordsText(result: RedFlagResult): string {
  const durations = new Set(result.category?.durationWords ?? [])
  const words = [...new Set(result.matched)].filter(word => !durations.has(word))
  const kept = words.filter(word => !words.some(other => other !== word && other.includes(word)))
  return kept.length > 0 ? kept.slice(0, 3).join('、') : '这些情况'
}

export interface ConsultPageProps {
  store: LocalStore
  modelStore?: LocalStore
  identity: Identity
  llm: LlmClient | null
  sendConsult?: (pkg: ConsultPackage) => Promise<void>
  member?: Pick<FamilyMember, 'account' | 'alias'> | null
  family?: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active?: number
  onSwitch?: (account: number) => void
  managerIdentity?: Identity
  teacher?: string | null
  teacherName?: string
  onBack?: () => void
}

// V2-17 学生问诊（10a–10d）：说一说 → 再问一句（可跳过） → 看一眼卡片再发出；急症只提醒、不拦截。
export function ConsultPage({ store, modelStore, identity, llm, sendConsult, member, family = [], active = 0, onSwitch, managerIdentity, teacher: venueTeacher, teacherName, onBack }: ConsultPageProps) {
  const [session, setSession] = useState<IntakeSession | null>(null)
  const [teachers, setTeachers] = useState<string[]>([])
  const [profile, setProfile] = useState<Encounter['profile'] | null>(null)
  const [draftText, setDraftText] = useState('')
  const [answerText, setAnswerText] = useState('')
  const [editing, setEditing] = useState(false)
  const [tongueOpen, setTongueOpen] = useState(false)
  const [heaven, setHeaven] = useState<HeavenTime | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const region = detectRegion(navigator.language)

  useEffect(() => {
    void loadTeachers(store).then(setTeachers).catch(() => {})
    void loadProfile(store).then(setProfile).catch(() => {})
    void heavenNow(store).then(setHeaven).catch(() => {})
    void loadDraft(store).then(draft => { if (draft) { setSession(draft); setStatus(draft.phase === 'confirm' ? '已读回上次未发出的卡片。' : '已读回上次未发送的草稿。') } }).catch(() => {})
  }, [store])

  const memberOption = member && profile ? { member: { age: profile.age.value } } : undefined
  const teacher = venueTeacher ?? teachers[0] ?? ''
  const call = (teacherName || '').trim() || '老师'
  const emergency: RedFlagResult | null = session?.emergency ?? null
  const crisis = Boolean(emergency?.actions.includes('crisis'))

  const apply = (next: IntakeSession, notice = '') => {
    setSession(next)
    setError('')
    if (notice) setStatus(notice)
    if (next.phase !== 'sent') void saveDraft(store, next).catch(() => setError('草稿没有保存成功。'))
  }

  const ensureSession = async (): Promise<IntakeSession | null> => {
    if (session) return session
    let currentTeacher = teacher
    if (!/^[0-9a-f]{64}$/.test(currentTeacher)) {
      const loaded = await loadTeachers(store)
      setTeachers(loaded)
      currentTeacher = loaded[0] ?? ''
    }
    if (!/^[0-9a-f]{64}$/.test(currentTeacher)) { setError('请先打开老师的邀请链接。'); return null }
    const next = startSession({ student: identity.publicKey, teacher: currentTeacher, template: template as TeacherTemplate })
    setSession(next)
    return next
  }

  // 10a：说一说 → 整理（有追问就进 10b，没有就进 10c）
  const speak = async () => {
    if (busy) return
    const text = draftText.trim()
    if (text === '') return
    setBusy(true); setError('')
    try {
      let next = await ensureSession()
      if (!next) return
      next = addUtterance(next, text)
      setDraftText('')
      next = await organizeSession(next, llm, memberOption)
      if (next.phase === 'confirm') next = markReviewed(next)
      apply(next, next.usedFallback && llm ? '模型暂不可用，已改用固定问句。' : '')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  // 10b：补充一句 / 跳过 → 整理
  const organize = async (answer: boolean) => {
    if (busy || !session || session.questions.length === 0) return
    if (answer && answerText.trim() === '') return
    setBusy(true); setError('')
    try {
      const focus = session.questions[0].focus
      let next = answer ? answerFocus(session, focus, answerText.trim()) : skipFocus(session, focus)
      if (answer) setAnswerText('')
      next = await organizeSession(next, llm, memberOption)
      if (next.phase === 'confirm') next = markReviewed(next)
      apply(next)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const sendPackage = async () => {
    if (!session || busy) return
    const allowed = canConfirm(session)
    if (!allowed.ok) { setError(allowed.reason ?? '暂时不能发送'); return }
    setBusy(true); setError('')
    try {
      const candidates = await loadHistory(store, session.teacher)
      const history = defaultHistorySelection(candidates, session.teacher)
      const sendFn = sendConsult ?? (async () => {})
      const [checkins, ratings, stress] = await Promise.all([listCheckins(store), listSelfRatings(store), listStressRatings(store)])
      const trend = last14DayTrend(checkins, ratings, stress)
      const currentProfile = await loadProfile(store)
      const stamp = heavenStampOf(await heavenNow(store))
      const attachments: { ref: { id: string; type: 'photo'; sha256: string; bytes: number }; data: Uint8Array }[] = []
      for (const record of session.tongues ?? []) {
        if (!record.crop) continue
        const data = await store.get(INTAKE_COLLECTIONS.attachmentData, record.crop.id)
        if (!(data instanceof Uint8Array) || data.length !== record.crop.bytes) throw Error('舌象裁剪图缺失，请重拍后再发送')
        attachments.push({ ref: { ...record.crop }, data })
      }
      const options = {
        ...(managerIdentity ? { manager: managerIdentity.publicKey, managerProof: createFamilyProof(managerIdentity, identity.publicKey) } : {}),
        heaven: stamp,
      }
      let observation: ConsultPackage['observation']
      try { observation = await buildPeriodObservation(store, { teacher: session.teacher }) } catch { observation = undefined }
      await confirmAndSend(store, session, currentProfile, history, attachments, sendFn, trend, observation ? { ...options, observation } : options)
      setSent(true)
      setSession({ ...session, phase: 'sent' })
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  if (sent) {
    return <main className="cf-page">
      <div className="cf-done">
        <h1>已发给老师</h1>
        <p className="nl-quiet">问诊卡片已发出。老师签字交还后，病历会出现在“记录”里。</p>
        {status && <p role="status" className="nl-quiet">{status}</p>}
        {onBack && <button type="button" className="nl-primary" onClick={onBack}>回到今天</button>}
      </div>
    </main>
  }

  const step: 'speak' | 'followup' | 'card' = session?.phase === 'confirm' ? 'card' : session && session.questions.length > 0 ? 'followup' : 'speak'
  const title = step === 'speak' ? `告诉${call}` : step === 'followup' ? '再问一句' : '看一眼，再发出'
  const subtitle = step === 'speak' ? (member ? `正在替 ${member.alias} 问诊` : '正在为本人问诊') : step === 'followup' ? '整理前，补充一点情况' : `发给${call}`
  const createdAt = session ? new Date(session.createdAt) : new Date()
  const meta = [member ? member.alias : '本人', `${createdAt.getMonth() + 1}月${createdAt.getDate()}日`, heaven ? `${heaven.shichen}时` : '', heaven?.city ?? ''].filter(Boolean).join(' · ')

  return <main className="cf-page">
    <header className="nl-flow-head cf-head">
      {onBack ? <button type="button" className="nl-back" aria-label="返回" onClick={onBack}>‹</button> : <span className="nl-back-placeholder" />}
      <div><h1>{title}</h1><small>{subtitle}</small></div>
    </header>
    <div className="cf-body">
      {family.length > 0 && <MemberSwitcher members={family} active={active} onChange={account => onSwitch?.(account)} />}
      {error && <p role="alert" className="nl-danger-strong">{error}</p>}
      {status && <p role="status" className="nl-quiet">{status}</p>}
      {!teachers.length && <p className="nl-quiet">请先打开老师的邀请链接。</p>}

      {step === 'speak' && <>
        <p className="cf-eyebrow">先说说你的情况</p>
        <h2 className="cf-title">哪里不舒服？</h2>
        <p className="cf-desc">像平时跟老师说话一样就行。</p>
        <label className="cf-label">你的话
          <textarea aria-label="按键盘上的🎤说话就行" rows={6} maxLength={2000} value={draftText} disabled={busy} placeholder="按键盘上的🎤说话就行" onChange={event => setDraftText(event.target.value)} />
        </label>
        <p className="nl-quiet cf-mic">🎙 也可以用键盘上的话筒说。</p>
        <div className="cf-note-card">我会帮你整理成一张卡片。<br />你看过，再发给老师。</div>
      </>}

      {step === 'followup' && session && <>
        <div className="cf-bubble">{session.texts[0] ?? ''}</div>
        <p className="cf-label">你的智能体</p>
        <div className="cf-question-card">
          <h2>{session.questions[0].text}</h2>
          <p className="nl-quiet">记不清也没关系，说个大概就好。</p>
        </div>
        <label className="cf-label">补充一下
          <textarea aria-label="补充一下" rows={4} maxLength={2000} value={answerText} disabled={busy} placeholder="想到什么说什么" onChange={event => setAnswerText(event.target.value)} />
        </label>
        <p className="nl-quiet">不想回答可以跳过，不会挡住发给老师。</p>
      </>}

      {step === 'card' && session && <>
        {emergency && (crisis
          ? <div className="cf-emergency"><RedFlagAlert result={emergency} region={region} /></div>
          : <div className="cf-emergency" role="alert">
            <h2>⚠ 请尽快去医院</h2>
            <p>你提到{matchedWordsText(emergency)}。<br />别等老师回复再去。</p>
          </div>)}
        {emergency && <p className="cf-emergency-note">仍然可以把情况发给{call}。</p>}
        <p className="cf-desc">这是按你的话整理的，<br />看看有没有说错、漏掉的。</p>
        <section className="cf-card" aria-label="问诊卡片">
          <div className="cf-card-head"><h2>问诊卡片</h2><span className="cf-tag">草稿 · 待你核对</span></div>
          <p className="nl-quiet">{meta}</p>
          <dl className="cf-fields">
            {(Object.keys(CARD_LABELS) as IntakeKey[]).map(key => <div key={key} className="cf-field">
              <dt>{CARD_LABELS[key]}</dt>
              <dd>{session.fields[key].value ?? '未提供'}</dd>
            </div>)}
          </dl>
          <button type="button" className="op-link-button cf-edit-toggle" onClick={() => setEditing(value => !value)}>{editing ? '收起' : '改一改你的话 ›'}</button>
          {editing && <div className="cf-edit">
            {(Object.keys(FIELD_LABELS) as IntakeKey[]).map(key => <label key={key}>{FIELD_LABELS[key]}
              <textarea rows={2} disabled={busy} value={session.fields[key].value ?? ''} onChange={event => setSession(updateField(session, key, event.target.value))} onBlur={() => void saveDraft(store, session).catch(() => {})} />
            </label>)}
          </div>}
        </section>

        <section className="cf-card cf-tongue" aria-label="这次的舌象">
          <div><strong>这次的舌象</strong><p className="nl-quiet">{session.tongues?.length ? `已拍 ${session.tongues.length} 张 · 可继续补拍` : '还没拍 · 可稍后补充'}</p></div>
          <button type="button" className="cf-link" onClick={() => setTongueOpen(value => !value)}>{tongueOpen ? '收起' : '去拍 ›'}</button>
        </section>
        {session.tongues?.map((record, index) => <TonguePair key={index} record={record} candidate={record} studentNote title={`舌象 ${index + 1} · ${record.shichen}时`} loadCrop={async () => { const id = record.crop?.id; if (!id) return null; const data = await store.get(INTAKE_COLLECTIONS.attachmentData, id); return data instanceof Uint8Array ? data : null }} missingCropState="missing" />)}
        {tongueOpen && <section className="cf-card cf-tongue-capture">
          <TongueCapture store={store} modelStore={modelStore} onBusyChange={setBusy} disabled={busy || (session.tongues?.length ?? 0) >= 4} onCaptured={async (record, _at, crop) => {
            if (!session) return
            await store.put(INTAKE_COLLECTIONS.attachmentData, record.crop!.id, crop)
            const next = addTongue(session, record)
            await saveDraft(store, next)
            setSession(next)
            setStatus('已附舌象裁剪图与候选特征，原图已从应用内清除')
          }} />
        </section>}
        <p className="nl-quiet">还没发出。点下面的按钮，{call}才会收到。</p>
      </>}
    </div>

    <footer className="cf-foot">
      {step === 'speak' && <button type="button" className="nl-primary" disabled={busy || draftText.trim() === ''} onClick={() => void speak()}>说好了，继续</button>}
      {step === 'followup' && <>
        <button type="button" className="nl-primary" disabled={busy || answerText.trim() === ''} onClick={() => void organize(true)}>补充好了，整理卡片</button>
        <button type="button" className="op-link-button" disabled={busy} onClick={() => void organize(false)}>跳过，直接整理</button>
      </>}
      {step === 'card' && <button type="button" className="nl-primary" disabled={busy} onClick={() => void sendPackage()}>{emergency ? `仍发给${call}` : `发给${call}`}</button>}
    </footer>
  </main>
}
