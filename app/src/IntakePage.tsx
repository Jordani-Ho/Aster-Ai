import { useEffect, useRef, useState } from 'react'
import template from '../../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../../domain/tcm/templates/types'
import type { Identity } from './core/identity'
import {
  INTAKE_COLLECTIONS,
  MAX_PHOTOS,
  addPhoto,
  addUtterance,
  answerFocus,
  canConfirm,
  confirmAndSend,
  defaultHistorySelection,
  emptyProfile,
  loadDraft,
  loadHistory,
  loadProfile,
  markReviewed,
  organizeSession,
  processPhoto,
  removePhoto,
  restartAfterEmergency,
  saveDraft,
  saveStoredPackage,
  skipFocus,
  startSession,
  updateField,
  type HistoryCandidate,
  type IntakeKey,
  type IntakeSession,
} from './core/intake'
import type { LlmClient } from './core/llm'
import type { AttachmentRef, ConsultPackage, Encounter } from './core/record/types'
import type { LocalStore } from './core/store'
import { detectRegion } from './core/redflags'
import { RedFlagAlert } from './RedFlagAlert'
import './intake.css'

const FIELD_LABELS: Record<IntakeKey, string> = {
  chiefComplaint: '最不舒服的地方（主诉）',
  presentIllness: '现在的情况（现病史）',
  history: '以前的病（既往史）',
  medsAllergies: '在吃的药、过敏',
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('')
}

function message(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '操作失败，请重试'
}

export interface IntakePageProps {
  store: LocalStore
  identity: Identity
  onBack: () => void
  // 有模型客户端时走模型整理；未配置（M1-07 设置还没有界面）或断网时自动退回固定问句。
  llm?: LlmClient | null
}

// 学生采集页：说话 → 本地急症筛查 → 追问 → 确认页核对 → 点“确认发送”才调用 send。
export function IntakePage({ store, identity, onBack, llm = null }: IntakePageProps) {
  const [session, setSession] = useState<IntakeSession | null>(null)
  const [teacherInput, setTeacherInput] = useState('')
  const [draftText, setDraftText] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [profile, setProfile] = useState<Encounter['profile']>(emptyProfile())
  const [historyCandidates, setHistoryCandidates] = useState<HistoryCandidate[]>([])
  const [selectedHistory, setSelectedHistory] = useState<string[]>([])
  const [photos, setPhotos] = useState<{ ref: AttachmentRef; data: Uint8Array }[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const region = detectRegion(navigator.language)

  useEffect(() => {
    void loadDraft(store).then(draft => {
      if (draft) { setSession(draft); setStatus('已恢复上次未发送的采集草稿。') }
    }).catch(() => setError('本机草稿读取失败，可以重新开始。'))
    void loadProfile(store).then(setProfile).catch(() => setProfile(emptyProfile()))
  }, [store])

  useEffect(() => {
    if (!session || session.phase !== 'confirm') return
    let cancelled = false
    void loadHistory(store, session.teacher).then(rows => {
      if (cancelled) return
      setHistoryCandidates(rows)
      setSelectedHistory(defaultHistorySelection(rows, session.teacher).map(item => item.id))
    }).catch(() => { if (!cancelled) setHistoryCandidates([]) })
    return () => { cancelled = true }
  }, [session?.phase, session?.teacher, store])

  const apply = (next: IntakeSession, notice = '') => {
    setSession(next)
    setError('')
    if (notice) setStatus(notice)
    if (next.phase !== 'sent') void saveDraft(store, next).catch(() => setError('草稿没有保存成功，请检查本机存储。'))
  }

  const begin = () => {
    setError('')
    const teacher = teacherInput.trim()
    if (!/^[0-9a-f]{64}$/.test(teacher)) { setError('请填写老师的 64 位十六进制公钥（由老师提供）。'); return }
    try {
      const next = startSession({ student: identity.publicKey, teacher, template: template as TeacherTemplate })
      apply(next, '采集只在本机进行；点“确认发送”之前，没有任何数据离开手机。')
    } catch (cause) { setError(message(cause)) }
  }

  const add = async () => {
    if (!session || busy) return
    setBusy(true); setError('')
    try {
      let next = addUtterance(session, draftText)
      setDraftText('')
      if (!next.emergency) {
        next = await organizeSession(next, llm)
        if (next.phase === 'confirm') next = markReviewed(next)
        apply(next, next.usedFallback && llm ? '模型暂不可用，已改用固定问句，采集继续。' : '')
      } else {
        apply(next)
      }
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const submitAnswer = async (focus: string) => {
    if (!session || busy) return
    setBusy(true); setError('')
    try {
      let next = answerFocus(session, focus, answers[focus] ?? '')
      setAnswers(previous => ({ ...previous, [focus]: '' }))
      if (!next.emergency) {
        next = await organizeSession(next, llm)
        if (next.phase === 'confirm') next = markReviewed(next)
      }
      apply(next, next.usedFallback && llm ? '模型暂不可用，已改用固定问句，采集继续。' : '')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const skip = async (focus: string) => {
    if (!session || busy) return
    setBusy(true); setError('')
    try {
      let next = skipFocus(session, focus)
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
        if (photos.length + added.length >= MAX_PHOTOS) break
        const bytes = new Uint8Array(await file.arrayBuffer())
        const result = await processPhoto({ bytes, type: file.type || 'image/jpeg' }, { existingCount: photos.length + added.length })
        added.push({ ref: result.ref, data: result.data })
        next = addPhoto(next, result)
      }
      setPhotos(previous => [...previous, ...added])
      apply(next, '照片已在本机缩小，并去掉了位置等 EXIF 信息。')
    } catch (cause) { setError(message(cause)) } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const remove = (refId: string) => {
    if (!session) return
    setPhotos(previous => previous.filter(item => item.ref.id !== refId))
    apply(removePhoto(session, refId))
  }

  const send = async () => {
    if (!session || busy) return
    const allowed = canConfirm(session)
    if (!allowed.ok) { setError(allowed.reason ?? '暂时不能发送'); return }
    setBusy(true); setError('')
    try {
      const candidates = historyCandidates.filter(item => selectedHistory.includes(item.id))
      // M1-05 还没合并：发送替身把问诊包加密存进本机待发集合，真发送接口接通后替换这一行。
      const sendStub = async (pkg: ConsultPackage) => { await saveStoredPackage(store, pkg, INTAKE_COLLECTIONS.outbox, session.encounterId) }
      await confirmAndSend(store, session, profile, candidates, photos, sendStub)
      setSent(true)
      setSession({ ...session, phase: 'sent' })
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const restart = () => {
    if (!session) return
    setPhotos([]); setAnswers({})
    apply(restartAfterEmergency(session), '已重新开始一次采集。')
  }

  const notifyTeacher = () => {
    if (!session?.emergency?.category) return
    void store.put('redflag-notify', randomId(), {
      categoryId: session.emergency.category.id,
      action: session.emergency.category.action,
      at: new Date().toISOString(),
    }).catch(() => setError('通知记录没有保存成功。'))
    setStatus('已记录，等中继接通后再发送。')
  }

  if (sent) {
    return <main className="intake-page">
      <header><p className="eyebrow">知衡 · 学生</p><h1>已确认</h1></header>
      <section className="intake-card">
        <p>问诊包已加密保存在本机，并留了一份你自己的副本。</p>
        <p className="privacy-note">中继还没有接通（M1-05）：接通后会把这份问诊包交给老师。在那之前不会自动外发。</p>
        <button onClick={onBack}>返回</button>
      </section>
    </main>
  }

  if (!session) {
    return <main className="intake-page">
      <header><p className="eyebrow">知衡 · 学生</p><h1>说说哪里不舒服</h1><p>可以打开输入法的语音输入，把感受说出来。</p></header>
      {status && <p role="status" className="intake-status">{status}</p>}
      {error && <p role="alert" className="intake-error">{error}</p>}
      <section className="intake-card">
        <label>老师的公钥（64 位十六进制）
          <input value={teacherInput} onChange={event => setTeacherInput(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="由老师提供" />
        </label>
        <p className="privacy-note">点“确认发送”之前，所有内容只在本机。急症筛查也在本机完成。</p>
        <div className="intake-actions">
          <button className="intake-primary" onClick={begin} disabled={busy}>开始采集</button>
          <button onClick={() => setTeacherInput('c'.repeat(64))}>填入合成示例</button>
          <button onClick={onBack}>返回</button>
        </div>
      </section>
    </main>
  }

  const allowed = canConfirm(session)
  return <main className="intake-page">
    <header>
      <button className="intake-back" onClick={onBack}>返回</button>
      <p className="eyebrow">知衡 · 学生</p>
      <h1>{session.phase === 'confirm' ? '确认后发送' : '说说哪里不舒服'}</h1>
      <p className="privacy-note">{session.usedFallback ? '这次用固定问句整理。' : '整理只摘取你说过的话。'}</p>
    </header>
    {error && <p role="alert" className="intake-error">{error}</p>}
    {status && <p role="status" className="intake-status">{status}</p>}
    {session.emergency && <RedFlagAlert result={session.emergency} region={region} status={status} onNotifyTeacher={notifyTeacher} onDismiss={restart} />}

    {session.phase === 'collecting' && <>
      <section className="intake-card">
        <label>用输入法的语音输入，或直接打字
          <textarea rows={3} value={draftText} onChange={event => setDraftText(event.target.value)} placeholder="例如：最近总是睡不好，白天没精神" />
        </label>
        <div className="intake-actions"><button className="intake-primary" disabled={busy || draftText.trim() === ''} onClick={() => void add()}>加入这一句</button></div>
      </section>
      {session.texts.length > 0 && <section className="intake-card">
        <h2>你说过的</h2>
        <ol className="intake-quotes">{session.texts.map((text, index) => <li key={index}>{text}</li>)}</ol>
      </section>}
      {session.questions.length > 0 && <section className="intake-card">
        <h2>还想问一下（第 {session.round} 轮，最多 3 轮）</h2>
        {session.questions.map(question => <div className="intake-question" key={question.focus}>
          <p className="intake-focus">{question.focus}</p>
          <p>{question.text}</p>
          <textarea rows={2} value={answers[question.focus] ?? ''} onChange={event => setAnswers(previous => ({ ...previous, [question.focus]: event.target.value }))} placeholder="不方便说可以跳过" />
          <div className="intake-actions">
            <button disabled={busy || (answers[question.focus] ?? '').trim() === ''} onClick={() => void submitAnswer(question.focus)}>回答</button>
            <button disabled={busy} onClick={() => void skip(question.focus)}>跳过</button>
          </div>
        </div>)}
      </section>}
    </>}

    {session.phase === 'confirm' && <>
      <section className="intake-card">
        <h2>核对整理后的内容</h2>
        <p className="privacy-note">每一项都可以改。只有你确认过的内容才会进问诊包。</p>
        {(Object.keys(FIELD_LABELS) as IntakeKey[]).map(key => <label key={key}>{FIELD_LABELS[key]}
          <textarea rows={3} value={session.fields[key].value ?? ''} placeholder="未知（可以留空，或补充）" onChange={event => setSession(updateField(session, key, event.target.value))} onBlur={() => void saveDraft(store, session).catch(() => {})} />
          <span className="intake-source">{session.fields[key].value === null ? '未知' : '你本人说的'}</span>
        </label>)}
      </section>
      <section className="intake-card">
        <h2>照片（可选，最多 {MAX_PHOTOS} 张）</h2>
        <p className="privacy-note">例如舌象。会在本机缩小、去掉位置信息后再放进问诊包。</p>
        {photos.length > 0 && <ul className="intake-photos">{photos.map(item => <li key={item.ref.id}><span>照片 · {Math.ceil(item.ref.bytes / 1024)} KB</span><button onClick={() => remove(item.ref.id)}>移除</button></li>)}</ul>}
        <input ref={fileInput} type="file" accept="image/*" multiple onChange={event => void addFiles(event.target.files)} />
      </section>
      <section className="intake-card">
        <h2>附带的旧病历（可选）</h2>
        <p className="privacy-note">默认勾选同一位老师的近 3 次；取消后不会放进问诊包。</p>
        {historyCandidates.length === 0 && <p>本机还没有这位老师的旧病历。</p>}
        {historyCandidates.map(item => <label className="intake-history" key={item.id}>
          <input type="checkbox" checked={selectedHistory.includes(item.id)} onChange={event => setSelectedHistory(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />
          {new Date(item.createdAt).toLocaleDateString()} 的病历
        </label>)}
      </section>
      <section className="intake-card">
        <h2>本机档案</h2>
        <p className="privacy-note">称呼、性别、年龄、八字和居住城市会随问诊包一起给老师；未填写的显示未知。</p>
        <p>称呼：{profile.alias.value ?? '未知'} · 性别：{profile.gender.value ?? '未知'} · 年龄：{profile.age.value ?? '未知'} · 城市：{profile.city.value ?? '未知'}</p>
      </section>
      <footer className="intake-footer">
        <p role="status">{allowed.ok ? '确认后，这份问诊包才会离开手机。' : allowed.reason}</p>
        <div className="intake-actions">
          <button className="intake-primary" disabled={busy || !allowed.ok} onClick={() => void send()}>确认发送</button>
          <button onClick={onBack}>返回</button>
        </div>
      </footer>
    </>}
  </main>
}
