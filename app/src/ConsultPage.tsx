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
import { heavenNow, heavenStampOf } from './core/heaven'
import { createFamilyProof } from './core/family/proof'
import type { FamilyMember } from './core/family'
import { MemberSwitcher } from './MemberSwitcher'
import { listCheckins } from './core/homework'
import { listSelfRatings, listStressRatings, last14DayTrend } from './core/mirror/trend'
import { detectRegion } from './core/redflags'
import { RedFlagAlert } from './RedFlagAlert'
import { uiError } from './core/onboarding/ui'
import { TongueCapture } from './TongueCapture'
import { TonguePair } from './TonguePair'

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
  modelStore?: LocalStore
  identity: Identity
  llm: LlmClient | null
  sendConsult?: (pkg: ConsultPackage) => Promise<void>
  /** M1-22：当前替哪位家人问诊、切换家人；managerIdentity 是代管人（根身份），用于签代管证明。 */
  member?: Pick<FamilyMember, 'account' | 'alias'> | null
  family?: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active?: number
  onSwitch?: (account: number) => void
  managerIdentity?: Identity
}

// 学生问诊页（对话式）：一个输入框 + 相机；AI 追问以气泡出现，最多 3 轮；
// 整理好的卡片可点开改，一个大按钮“发给老师”。急症只内联提示、不拦截、不给号码。
export function ConsultPage({ store, modelStore, identity, llm, sendConsult, member, family = [], active = 0, onSwitch, managerIdentity }: ConsultPageProps) {
  const [session, setSession] = useState<IntakeSession | null>(null)
  const [teachers, setTeachers] = useState<string[]>([])
  const [draftText, setDraftText] = useState('')
  const [profile, setProfile] = useState<Encounter['profile'] | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const region = detectRegion(navigator.language)

  useEffect(() => {
    void loadTeachers(store).then(setTeachers).catch(() => {})
    void loadProfile(store).then(setProfile).catch(() => {})
    void loadDraft(store).then(draft => { if (draft) { setSession(draft); setStatus('已读回上次未发送的草稿。') } }).catch(() => {})
  }, [store])

  // 替家人问诊时把年龄带进追问提示词；本人问诊不带。
  const memberOption = member && profile ? { member: { age: profile.age.value } } : undefined

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
      next = await organizeSession(next, llm, memberOption)
      if (next.phase === 'confirm') next = markReviewed(next)
      apply(next, next.usedFallback && llm ? '模型暂不可用，已改用固定问句。' : '')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const skip = async () => {
    if (busy || !session || session.questions.length === 0) return
    setBusy(true); setError('')
    try {
      let next = skipFocus(session, session.questions[0].focus)
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
      // V2-06：学生点“确认发送”时取一次天地人（时辰、节气、城市），随问诊包给老师；签字病历原样沿用。
      const heaven = heavenStampOf(await heavenNow(store))
      // V2-08：每份舌象只把舌头裁剪图放进既有附件通道，原图早已清零、不会出现在这里。
      const attachments: { ref: { id: string; type: 'photo'; sha256: string; bytes: number }; data: Uint8Array }[] = []
      for (const record of session.tongues ?? []) {
        if (!record.crop) continue
        const data = await store.get(INTAKE_COLLECTIONS.attachmentData, record.crop.id)
        if (!(data instanceof Uint8Array) || data.length !== record.crop.bytes) throw Error('舌象裁剪图缺失，请重拍后再发送')
        attachments.push({ ref: { ...record.crop }, data })
      }
      const options = {
        ...(managerIdentity ? { manager: managerIdentity.publicKey, managerProof: createFamilyProof(managerIdentity, identity.publicKey) } : {}),
        heaven,
      }
      await confirmAndSend(store, session, currentProfile, history, attachments, sendFn, trend, options)
      setSent(true)
      setSession({ ...session, phase: 'sent' })
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  if (sent) {
    return <main className="consult-page">
      <header><p className="eyebrow">知衡 · 学生</p><h1>已发给老师</h1></header>
      <section className="consult-card"><p>问诊卡片已发出。老师签字交还后，病历会出现在“其他 → 我的病历”。</p></section>
    </main>
  }

  const pendingQuestion = session?.questions[0]
  return <main className="consult-page">
    {family.length > 0 && <MemberSwitcher members={family} active={active} onChange={account => onSwitch?.(account)} />}
    <header><p className="eyebrow">知衡 · 学生</p><h1>问诊</h1><p>哪里不舒服，说出来就行。</p>{member && <p role="status">替 {member.alias} 问诊</p>}<p className="consult-note">急症筛查在本机完成；所需原话交给您接入的模型整理，确认发送后交给老师。</p></header>
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
      {member && <p role="status">替 {member.alias} 问诊</p>}
      <p className="consult-note">每一项都可以改；只有你确认过的内容才会发给老师。</p>
      {(Object.keys(FIELD_LABELS) as IntakeKey[]).map(key => <label key={key}>{FIELD_LABELS[key]}
        <textarea disabled={busy} rows={2} value={session.fields[key].value ?? ''} onChange={event => setSession(updateField(session, key, event.target.value))} onBlur={() => void saveDraft(store, session).catch(() => {})} />
      </label>)}
      {session.tongues?.map((record,index)=><TonguePair key={index} record={record} candidate={record} studentNote title={`舌象 ${index+1} · ${record.shichen}时`} loadCrop={async()=>{const id=record.crop?.id;if(!id)return null;const data=await store.get(INTAKE_COLLECTIONS.attachmentData,id);return data instanceof Uint8Array?data:null}} missingCropState="missing"/>)}
      <button className="consult-send" disabled={busy} onClick={() => void sendPackage()}>发给老师</button>
    </section>}

    {!sent && <div className="consult-input-row">
      <TongueCapture store={store} modelStore={modelStore} onBusyChange={setBusy} disabled={!session||busy||(session.tongues?.length??0)>=4} onCaptured={async(record,_at,crop)=>{if(session){await store.put(INTAKE_COLLECTIONS.attachmentData,record.crop!.id,crop);const next=addTongue(session,record);await saveDraft(store,next);setSession(next);setStatus('已附舌象裁剪图与候选特征，原图已从应用内清除')}}}/>
      <textarea aria-label="按键盘上的🎤说话就行" rows={1} placeholder="按键盘上的🎤说话就行" value={draftText} onChange={event => setDraftText(event.target.value)} />
      <button className="consult-send-btn" disabled={busy || draftText.trim() === ''} onClick={() => void send()}>发送</button>
    </div>}
  </main>
}
