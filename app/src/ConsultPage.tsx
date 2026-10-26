import { useEffect, useRef, useState } from 'react'
import template from '../../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../../domain/tcm/templates/types'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { ConsultPackage, Encounter } from './core/record/types'
import {
  addPostureSegment, addTongue, addUtterance, answerFocus, canConfirm, confirmAndSend, INTAKE_COLLECTIONS,
  addRecording, defaultHistorySelection, loadDraft, loadHistory, loadOrganizationPairs, loadProfile, markReviewed,
  organizeSession, removePostureSegment, removeRecording, saveDraft, skipRemainingFocuses, startSession, updateField,
  updatePostureNote,
  type IntakeKey, type IntakeSession,
} from './core/intake'
import { newStudentPostureSegment } from './core/posture'
import { loadTeachers } from './core/inbox'
import { heavenNow, heavenStampOf, type HeavenTime } from './core/heaven'
import { createFamilyProof } from './core/family/proof'
import type { FamilyMember } from './core/family'
import { MemberSwitcher } from './MemberSwitcher'
import { listCheckins } from './core/homework'
import { listSelfRatings, listStressRatings, last14DayTrend } from './core/mirror/trend'
import { uiError } from './core/onboarding/ui'
import { TongueCapture } from './TongueCapture'
import { TonguePair } from './TonguePair'
import { intakeDefaults, refreshProfile } from './core/basics'
import { PostureAtHome } from './PostureAtHome'
import { CareReminder } from './CareReminder'
import { buildPeriodObservation } from './core/kangbi'
import { listHerbs, loadHerbUnits, snapshotHomeHerbs, type SharedHomeHerbSnapshot } from './core/herbs'
import { AUDIO_MIME_TYPES, createAudioAttachment, MAX_AUDIO_SEGMENT_MS, MAX_AUDIO_TOTAL_MS } from './core/intake/audio'
import { loadCachedReceiveRecordings } from './core/storefront'
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
  onOpenHerbs?: () => void
}

// V2-17 学生问诊（10a–10d）：说一说 → 再问一句（可跳过） → 看一眼卡片再发出；急症只提醒、不拦截。
export function ConsultPage({ store, modelStore, identity, llm, sendConsult, member, family = [], active = 0, onSwitch, managerIdentity, teacher: venueTeacher, teacherName, onBack, onOpenHerbs }: ConsultPageProps) {
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
  // V2-23：基础信息里的既往史、用药过敏，问诊卡里自动带上（学生可改）。
  const [defaults, setDefaults] = useState<{ history: string | null; medsAllergies: string | null }>({ history: null, medsAllergies: null })
  const [homeHerbs, setHomeHerbs] = useState<SharedHomeHerbSnapshot[]>([])
  const [receiveRecordings, setReceiveRecordings] = useState(true)
  const [recordingSupported, setRecordingSupported] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordingUrls, setRecordingUrls] = useState<Record<string, string>>({})
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const stopRecordingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressingAudio = useRef(false)
  const sessionRef = useRef<IntakeSession | null>(null)
  const herbStore = modelStore ?? store
  const updateSession = (next: IntakeSession | null) => { sessionRef.current = next; setSession(next) }

  useEffect(() => {
    void refreshProfile(store).then(setProfile).catch(() => { void loadProfile(store).then(setProfile).catch(() => {}) })
    void intakeDefaults(store).then(setDefaults).catch(() => {})
    void heavenNow(store).then(setHeaven).catch(() => {})
    void Promise.all([listHerbs(herbStore), loadHerbUnits(herbStore)])
      .then(([herbs, units]) => setHomeHerbs(snapshotHomeHerbs(herbs, units))).catch(() => setHomeHerbs([]))
    void loadDraft(store).then(draft => { if (draft && sessionRef.current === null) { updateSession(draft); setStatus(draft.phase === 'confirm' ? '已读回上次未发出的卡片。' : '已读回上次未发送的草稿。') } }).catch(() => {})
  }, [store, herbStore])

  useEffect(() => {
    let active = true
    const refresh = () => { void loadTeachers(store).then(rows => { if (active) setTeachers(rows) }).catch(() => {}) }
    refresh()
    window.addEventListener('aster:data-changed', refresh)
    return () => { active = false; window.removeEventListener('aster:data-changed', refresh) }
  }, [store])

  const memberOption = member && profile ? { member: { age: profile.age.value } } : undefined
  // undefined 是独立使用问诊页时未指定老师；null 是外层明确没有可用的馆。
  const teacher = venueTeacher === undefined ? teachers[0] ?? '' : venueTeacher ?? ''
  const call = (teacherName || '').trim() || '老师'

  useEffect(() => {
    setRecordingSupported(typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia)
  }, [])
  useEffect(() => {
    let active = true
    void loadCachedReceiveRecordings(store, teacher).then(value => { if (active) setReceiveRecordings(value) }).catch(() => { if (active) setReceiveRecordings(true) })
    return () => { active = false }
  }, [store, teacher])
  useEffect(() => {
    const refs = session?.recordings ?? []
    let active = true
    const urls: string[] = []
    void Promise.all(refs.map(async ref => {
      const data = await store.get(INTAKE_COLLECTIONS.attachmentData, ref.id)
      if (!(data instanceof Uint8Array) || !active) return null
      const url = URL.createObjectURL(new Blob([data.slice().buffer as ArrayBuffer], { type: ref.mimeType }))
      urls.push(url)
      return [ref.id, url] as const
    })).then(rows => { if (active) setRecordingUrls(Object.fromEntries(rows.filter((item): item is readonly [string, string] => item !== null))) })
    return () => { active = false; urls.forEach(url => URL.revokeObjectURL(url)) }
  }, [store, session?.recordings])
  useEffect(() => () => {
    if (stopRecordingTimer.current) clearTimeout(stopRecordingTimer.current)
    recorderRef.current?.stop()
    recordingStreamRef.current?.getTracks().forEach(track => track.stop())
  }, [])

  const apply = (incoming: IntakeSession, notice = '') => {
    let next = incoming
    if (next.phase === 'confirm') {
      if (defaults.history && !next.fields.history.value) next = updateField(next, 'history', defaults.history)
      if (defaults.medsAllergies && !next.fields.medsAllergies.value) next = updateField(next, 'medsAllergies', defaults.medsAllergies)
    }
    updateSession(next)
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
    updateSession(next)
    return next
  }

  const stopRecording = () => {
    if (stopRecordingTimer.current) clearTimeout(stopRecordingTimer.current)
    stopRecordingTimer.current = null
    const active = recorderRef.current
    if (active && active.state !== 'inactive') active.stop()
  }

  const startRecording = async () => {
    if (!recordingSupported || !receiveRecordings || recorderRef.current) return
    const current = await ensureSession()
    if (!current) return
    const existing = current.recordings ?? []
    const durationMs = existing.reduce((sum, ref) => sum + (ref.durationMs ?? 0), 0)
    const bytes = existing.reduce((sum, ref) => sum + ref.bytes, 0)
    if (durationMs >= MAX_AUDIO_TOTAL_MS) { setStatus('本次录音已到 10 分钟上限，可以继续用文字。'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!pressingAudio.current) { stream.getTracks().forEach(track => track.stop()); return }
      const mimeType = AUDIO_MIME_TYPES.find(type => MediaRecorder.isTypeSupported?.(type))
      const recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 24_000,
        ...(mimeType ? { mimeType } : {}),
      })
      const chunks: BlobPart[] = []
      const startedAt = performance.now()
      recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.onstop = () => {
        const elapsed = Math.max(1, Math.round(performance.now() - startedAt))
        stream.getTracks().forEach(track => track.stop())
        recordingStreamRef.current = null
        recorderRef.current = null
        setRecording(false)
        const blob = new Blob(chunks, { type: recorder.mimeType })
        void (async () => {
          try {
            const actualMime = AUDIO_MIME_TYPES.find(type => (blob.type || recorder.mimeType).toLowerCase().startsWith(type)) ?? ''
            const clip = await createAudioAttachment(new Uint8Array(await blob.arrayBuffer()), actualMime, elapsed, { durationMs, bytes })
            await store.put(INTAKE_COLLECTIONS.attachmentData, clip.ref.id, clip.data)
            const next = addRecording(sessionRef.current ?? current, clip.ref)
            await saveDraft(store, next)
            updateSession(next)
            setStatus('录音已加好。送达后，录音会从这台手机清除。')
          } catch (cause) { setError(message(cause)) }
        })()
      }
      recorder.start()
      recorderRef.current = recorder
      recordingStreamRef.current = stream
      setRecording(true); setError(''); setStatus('按住录音，松开就停。')
      stopRecordingTimer.current = setTimeout(() => { pressingAudio.current = false; setStatus('单段已到 3 分钟上限。'); stopRecording() }, MAX_AUDIO_SEGMENT_MS)
    } catch {
      setStatus('录音没开，可以继续用键盘输入。')
    }
  }

  // 10a：说一说 → 整理（有追问就进 10b，没有就进 10c）
  const speak = async () => {
    if (busy) return
    const text = draftText
    if (text.trim() === '') return
    setBusy(true); setError('')
    try {
      let next = await ensureSession()
      if (!next) return
      next = addUtterance(next, text)
      setDraftText('')
      const organizationPairs = await loadOrganizationPairs(store, next.teacher)
      next = await organizeSession(next, llm, { ...(memberOption ?? {}), organizationPairs })
      if (next.phase === 'confirm') next = markReviewed(next)
      apply(next, next.usedFallback && llm ? '模型暂不可用，已改用固定问句。' : '')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  // 10b：补充这一问 → 继续整理（还有要问的继续问，没有就到卡片页）
  const organize = async () => {
    if (busy || !session || session.questions.length === 0) return
    if (answerText.trim() === '') return
    setBusy(true); setError('')
    try {
      const focus = session.questions[0].focus
      let next = answerFocus(session, focus, answerText)
      setAnswerText('')
      const organizationPairs = await loadOrganizationPairs(store, next.teacher)
      next = await organizeSession(next, llm, { ...(memberOption ?? {}), organizationPairs })
      if (next.phase === 'confirm') next = markReviewed(next)
      apply(next)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  // V2-29：跳过 = 结束追问、直接进“看一眼，再发出”；不调用模型，剩下没问的项按跳过记（字段保持 unknown）。
  const skipToCard = () => {
    if (busy || !session || session.questions.length === 0) return
    setError('')
    try {
      apply(markReviewed(skipRemainingFocuses(session)))
    } catch (cause) { setError(message(cause)) }
  }

  const sendPackage = async () => {
    if (!session || busy) return
    // 请出后这位老师已从“我的老师”移除；以当前可用的老师（外层指定，或本机名单第一位）为准。
    if (!teacher || session.teacher !== teacher) { setError('请先请老师重新邀请你'); return }
    const allowed = canConfirm(session)
    if (!allowed.ok) { setError(allowed.reason ?? '暂时不能发送'); return }
    setBusy(true); setError('')
    try {
      const candidates = await loadHistory(store, session.teacher)
      const history = defaultHistorySelection(candidates, session.teacher)
      const sendFn = sendConsult ?? (async () => {})
      const shouldSendRecordings = await loadCachedReceiveRecordings(store, session.teacher)
      setReceiveRecordings(shouldSendRecordings)
      const [checkins, ratings, stress] = await Promise.all([listCheckins(store), listSelfRatings(store), listStressRatings(store)])
      const trend = last14DayTrend(checkins, ratings, stress)
      // V2-23：年龄和八字每次现算；没有基础信息时沿用原 profile。
      const currentProfile = await refreshProfile(store).catch(() => loadProfile(store))
      const stamp = heavenStampOf(await heavenNow(store))
      const attachments: { ref: NonNullable<IntakeSession['attachments']>[number]; data: Uint8Array }[] = []
      for (const record of session.tongues ?? []) {
        if (!record.crop) continue
        const data = await store.get(INTAKE_COLLECTIONS.attachmentData, record.crop.id)
        if (!(data instanceof Uint8Array) || data.length !== record.crop.bytes) throw Error('舌象裁剪图缺失，请重拍后再发送')
        attachments.push({ ref: { ...record.crop }, data })
      }
      if (shouldSendRecordings) for (const ref of session.recordings ?? []) {
        const data = await store.get(INTAKE_COLLECTIONS.attachmentData, ref.id)
        if (!(data instanceof Uint8Array) || data.length !== ref.bytes) throw Error('录音缺失，请重录后再发送')
        attachments.push({ ref: { ...ref }, data })
      }
      const options = {
        ...(managerIdentity ? { manager: managerIdentity.publicKey, managerProof: createFamilyProof(managerIdentity, identity.publicKey) } : {}),
        heaven: stamp,
        receiveRecordings: shouldSendRecordings,
      }
      let observation: ConsultPackage['observation']
      try { observation = await buildPeriodObservation(store, { teacher: session.teacher }) } catch { observation = undefined }
      let shared: SharedHomeHerbSnapshot[] = []
      try {
        const [herbs, units] = await Promise.all([listHerbs(herbStore), loadHerbUnits(herbStore)])
        shared = snapshotHomeHerbs(herbs, units)
      } catch { /* 库存读取失败不能挡住学生发送问诊。 */ }
      await confirmAndSend(store, session, currentProfile, history, attachments, sendFn, trend, { ...options, ...(observation ? { observation } : {}), homeHerbs: shared })
      setSent(true)
      updateSession({ ...(sessionRef.current ?? session), phase: 'sent' })
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
    <CareReminder />
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
        {recordingSupported && receiveRecordings && <div className="cf-recording-control">
          <button type="button" aria-label={recording ? '正在录音，松开停止' : '按住录音'} aria-pressed={recording}
            className={recording ? 'cf-record-button is-recording' : 'cf-record-button'} disabled={busy || (session?.recordings ?? []).reduce((sum, ref) => sum + (ref.durationMs ?? 0), 0) >= MAX_AUDIO_TOTAL_MS}
            onPointerDown={event => { event.preventDefault(); pressingAudio.current = true; void startRecording() }}
            onPointerUp={() => { pressingAudio.current = false; stopRecording() }}
            onPointerCancel={() => { pressingAudio.current = false; stopRecording() }}
            onPointerLeave={() => { if (recording) { pressingAudio.current = false; stopRecording() } }}
            onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); pressingAudio.current = true; void startRecording() } }}
            onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { pressingAudio.current = false; stopRecording() } }}
            onContextMenu={event => event.preventDefault()}>{recording ? '正在录音 · 松开结束' : '按住录音'}</button>
          <p className="nl-quiet">每段最多 3 分钟，一次问诊最多 10 分钟。</p>
        </div>}
        {recordingSupported && !receiveRecordings && <p className="nl-quiet">这位老师暂不接收录音，可以继续用文字问诊。</p>}
        <div className="cf-note-card">我会帮你整理成一张卡片。<br />你看过，再发给老师。</div>
        {onOpenHerbs && <button type="button" className="cf-link" onClick={onOpenHerbs}>整理家里的药材 ›</button>}
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
        <p className="cf-desc">这是按你的话整理的，<br />看看有没有说错、漏掉的。</p>
        <section className="cf-card" aria-label="问诊卡片">
          <div className="cf-card-head"><h2>问诊卡片</h2><span className="cf-tag">草稿 · 待你核对</span></div>
          <p className="nl-quiet">{meta}</p>
          <dl className="cf-fields">
            {(Object.keys(CARD_LABELS) as IntakeKey[]).map(key => <div key={key} className="cf-field">
              <dt>{CARD_LABELS[key]}</dt>
              <dd>{session.fields[key].value ?? '未提供'}</dd>
              {session.organized?.[key]?.text && <small className="cf-citations">智能体整理 · 依据原话 {session.organized[key].citations.map(id => `#${id}`).join('、')}</small>}
            </div>)}
          </dl>
          <button type="button" className="op-link-button cf-edit-toggle" onClick={() => setEditing(value => !value)}>{editing ? '收起' : '改一改你的话 ›'}</button>
          {editing && <div className="cf-edit">
            {(Object.keys(FIELD_LABELS) as IntakeKey[]).map(key => <label key={key}>{FIELD_LABELS[key]}
              <textarea rows={2} disabled={busy} value={session.fields[key].value ?? ''} onChange={event => updateSession(updateField(session, key, event.target.value))} onBlur={() => void saveDraft(store, session).catch(() => {})} />
            </label>)}
          </div>}
        </section>

        <details className="cf-card" aria-label="本次原话和追问回答">
          <summary>本次原话与问答 · {session.originals?.length ?? session.texts.length} 句</summary>
          <ol className="cf-originals">{(session.originals ?? session.texts.map((text, index) => ({ id: index + 1, text, source: 'spoken' as const }))).map(line => <li key={line.id}><span>#{line.id}</span> {line.text}</li>)}</ol>
          {(session.qa ?? []).length > 0 && <div className="cf-qa-list"><h3>追问记录</h3>{session.qa!.map((item, index) => <p key={`${item.originalId}-${index}`}><strong>{item.question}</strong><br />{item.answer}</p>)}</div>}
        </details>

        {(session.recordings ?? []).length > 0 && <section className="cf-card" aria-label="本次录音">
          <h3>本次录音 · {receiveRecordings ? '会随问诊包发给老师' : '老师暂不接收，不会上传'}</h3>
          {session.recordings!.map((ref, index) => <div key={ref.id} className="cf-audio-row">
            <p>第 {index + 1} 段 · {Math.ceil((ref.durationMs ?? 0) / 1000)} 秒</p>
            {recordingUrls[ref.id] && <audio controls preload="none" src={recordingUrls[ref.id]}>浏览器不支持播放。</audio>}
            <button type="button" className="op-link-button" disabled={busy} onClick={() => {
              void (async () => { await store.delete(INTAKE_COLLECTIONS.attachmentData, ref.id); const next = removeRecording(sessionRef.current ?? session, ref.id); await saveDraft(store, next); updateSession(next) })().catch(cause => setError(message(cause)))
            }}>删掉这段</button>
          </div>)}
          <p className="nl-quiet">问诊包确认送达后，录音会从本机清除。</p>
        </section>}

        <details className="cf-card" aria-label="随问诊附上的家中药材">
          <summary>随问诊附上家里的药材 · {homeHerbs.length} 味</summary>
          <p className="nl-quiet">只在这次远程问诊时发给老师，不会实时同步。</p>
          {homeHerbs.length
            ? <ul>{homeHerbs.map(herb => <li key={herb.name}>{herb.name} · {herb.quantity}{herb.unit}</li>)}</ul>
            : <p className="nl-quiet">药材库为空，问诊包不附库存。</p>}
          {onOpenHerbs && <button type="button" className="cf-link" onClick={onOpenHerbs}>管理家里的药材 ›</button>}
        </details>

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
            updateSession(next)
            setStatus('已附舌象裁剪图与候选特征，原图已从应用内清除')
          }} />
        </section>}
        <PostureAtHome posture={session.posture} disabled={busy} onBusyChange={setBusy}
          onFrame={frame => { try { apply(addPostureSegment(session, newStudentPostureSegment(frame))) } catch (cause) { setError(message(cause)) } }}
          onRemove={segmentId => { try { apply(removePostureSegment(session, segmentId)) } catch (cause) { setError(message(cause)) } }}
          onNote={(segmentId, note) => { try { apply(updatePostureNote(session, segmentId, note)) } catch (cause) { setError(message(cause)) } }} />
        <p className="nl-quiet">还没发出。点下面的按钮，{call}才会收到。</p>
      </>}
    </div>

    <footer className="cf-foot">
      {step === 'speak' && <button type="button" className="nl-primary" disabled={busy || draftText.trim() === ''} onClick={() => void speak()}>说好了，继续</button>}
      {step === 'followup' && <>
        <button type="button" className="nl-primary" disabled={busy || answerText.trim() === ''} onClick={() => void organize()}>补充好了，整理卡片</button>
        <button type="button" className="op-link-button" disabled={busy} onClick={skipToCard}>跳过，直接整理</button>
      </>}
      {step === 'card' && (teacher && teacher === session?.teacher
        ? <button type="button" className="nl-primary" disabled={busy} onClick={() => void sendPackage()}>发给{call}</button>
        : <p role="status">请先请老师重新邀请你</p>)}
    </footer>
  </main>
}
