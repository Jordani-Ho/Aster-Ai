import { useEffect, useRef, useState } from 'react'
import template from '../../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../../domain/tcm/templates/types'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { AttachmentRef, ConsultPackage } from './core/record/types'
import {
  addPhoto, addUtterance, answerFocus, canConfirm, confirmAndSend,
  defaultHistorySelection, loadDraft, loadHistory, loadProfile, markReviewed,
  organizeSession, processPhoto, saveDraft, skipFocus, startSession, updateField,
  type IntakeKey, type IntakeSession,
} from './core/intake'
import { loadTeachers } from './core/inbox'
import { detectRegion } from './core/redflags'
import { RedFlagAlert } from './RedFlagAlert'
import { uiError } from './core/onboarding/ui'

const FIELD_LABELS: Record<IntakeKey, string> = {
  chiefComplaint: '最不舒服的地方（主诉）',
  presentIllness: '现在的情况（现病史）',
  history: '以前的病（既往史）',
  medsAllergies: '在吃的药、过敏',
}

function message(cause: unknown): string {
  return uiError(cause, '操作失败，请重试')
}

export interface ConsultPageProps {
  store: LocalStore
  identity: Identity
  llm: LlmClient | null
  sendConsult?: (pkg: ConsultPackage) => Promise<void>
}

// 学生问诊页（对话式）：一个输入框 + 相机；AI 追问以气泡出现，最多 3 轮；
// 整理好的卡片可点开改，一个大按钮“发给老师”。急症只内联提示、不拦截、不给号码。
export function ConsultPage({ store, identity, llm, sendConsult }: ConsultPageProps) {
  const [session, setSession] = useState<IntakeSession | null>(null)
  const [teachers, setTeachers] = useState<string[]>([])
  const [draftText, setDraftText] = useState('')
  const [photos, setPhotos] = useState<{ ref: AttachmentRef; data: Uint8Array }[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const region = detectRegion(navigator.language)

  useEffect(() => {
    void loadTeachers(store).then(setTeachers).catch(() => {})
    void loadDraft(store).then(draft => { if (draft) { setSession(draft); setStatus('已恢复上次未发送的草稿。') } }).catch(() => {})
  }, [store])

  const apply = (next: IntakeSession, notice = '') => {
    setSession(next)
    setError('')
    if (notice) setStatus(notice)
    if (next.phase !== 'sent') void saveDraft(store, next).catch(() => setError('草稿没有保存成功。'))
  }

  const teacher = teachers[0] ?? ''

  const send = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      let next = session
      if (!next) {
        let currentTeacher = teacher
        if (!/^[0-9a-f]{64}$/.test(currentTeacher)) {
          const loaded = await loadTeachers(store)
          setTeachers(loaded)
          currentTeacher = loaded[0] ?? ''
        }
        if (!/^[0-9a-f]{64}$/.test(currentTeacher)) { setError('请先打开老师的邀请链接。'); setBusy(false); return }
        next = startSession({ student: identity.publicKey, teacher: currentTeacher, template: template as TeacherTemplate })
      }
      const text = draftText.trim()
      if (next.questions.length > 0) {
        if (text === '') { setBusy(false); return }
        next = answerFocus(next, next.questions[0].focus, text)
      } else {
        if (text === '') { setBusy(false); return }
        next = addUtterance(next, text)
      }
      setDraftText('')
      next = await organizeSession(next, llm)
      if (next.phase === 'confirm') next = markReviewed(next)
      apply(next, next.usedFallback && llm ? '模型暂不可用，已改用固定问句。' : '')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const skip = async () => {
    if (busy || !session || session.questions.length === 0) return
    setBusy(true); setError('')
    try {
      let next = skipFocus(session, session.questions[0].focus)
      next = await organizeSession(next, llm)
      if (next.phase === 'confirm') next = markReviewed(next)
      apply(next)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const addFiles = async (files: FileList | null) => {
    if (!session || !files || busy) return
    setBusy(true); setError('')
    try {
      let next = session
      const added: { ref: AttachmentRef; data: Uint8Array }[] = []
      for (const file of Array.from(files)) {
        if (photos.length + added.length >= 4) break
        const bytes = new Uint8Array(await file.arrayBuffer())
        const result = await processPhoto({ bytes, type: file.type || 'image/jpeg' }, { existingCount: photos.length + added.length })
        added.push({ ref: result.ref, data: result.data })
        next = addPhoto(next, result)
      }
      setPhotos(previous => [...previous, ...added])
      apply(next, '照片已在本机缩小，并去掉了位置信息。')
    } catch (cause) { setError(message(cause)) } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
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
      await confirmAndSend(store, session, await loadProfile(store), history, photos, sendFn)
      setSent(true)
      setSession({ ...session, phase: 'sent' })
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  if (sent) {
    return <main className="consult-page">
      <header><p className="eyebrow">知衡 · 学生</p><h1>已发给老师</h1></header>
      <section className="consult-card"><p>问诊包已加密发出。老师签字交还后，病历会出现在“其他 → 我的病历”。</p></section>
    </main>
  }

  const pendingQuestion = session?.questions[0]
  return <main className="consult-page">
    <header><p className="eyebrow">知衡 · 学生</p><h1>问诊</h1><p>哪里不舒服，说出来就行。</p><p className="consult-note">急症筛查在本机完成；所需原话交给您接入的模型整理，确认发送后交给老师。</p></header>
    {error && <p role="alert" className="consult-error">{error}</p>}
    {status && <p role="status" className="consult-status">{status}</p>}

    <section className="chat" aria-label="问诊对话">
      {!teachers.length && <p className="consult-note">请先打开老师的邀请链接。</p>}
      {session?.texts.map((text, index) => <div className="bubble student" key={'t' + index}>{text}</div>)}
      {session?.emergency && <RedFlagAlert result={session.emergency} region={region} />}
      {pendingQuestion && <div className="bubble ai" key={'q' + pendingQuestion.focus}>
        <p className="bubble-focus">{pendingQuestion.focus}</p>
        <p>{pendingQuestion.text}</p>
        <div className="bubble-actions">
          <button disabled={busy} onClick={() => void skip()}>跳过</button>
        </div>
      </div>}
      {session && session.questions.length === 0 && session.phase !== 'confirm' && <div className="bubble ai">还在听你说，可以继续说。</div>}
    </section>

    {session?.phase === 'confirm' && <section className="consult-card">
      <h2>整理好的卡片</h2>
      <p className="consult-note">每一项都可以改；只有你确认过的内容才会发给老师。</p>
      {(Object.keys(FIELD_LABELS) as IntakeKey[]).map(key => <label key={key}>{FIELD_LABELS[key]}
        <textarea rows={2} value={session.fields[key].value ?? ''} onChange={event => setSession(updateField(session, key, event.target.value))} onBlur={() => void saveDraft(store, session).catch(() => {})} />
      </label>)}
      {photos.length > 0 && <p>照片 {photos.length} 张（含舌象等）。</p>}
      <button className="consult-send" onClick={() => void sendPackage()}>发给老师</button>
    </section>}

    {!sent && <div className="consult-input-row">
      <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={event => void addFiles(event.target.files)} />
      <button aria-label="拍照或选择照片" className="consult-camera" onClick={() => fileInput.current?.click()}>📷</button>
      <textarea aria-label="按键盘上的🎤说话就行" rows={1} placeholder="按键盘上的🎤说话就行" value={draftText} onChange={event => setDraftText(event.target.value)} />
      <button className="consult-send-btn" disabled={busy || draftText.trim() === ''} onClick={() => void send()}>发送</button>
    </div>}
  </main>
}
