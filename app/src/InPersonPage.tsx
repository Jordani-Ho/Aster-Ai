import { loadTeacherTemplate } from './core/drafting/template'
import { reviseEncounter } from './core/drafting/revise'
import { organizeIntake, fixedQuestions } from './core/intake/followup'
import {uiError} from './core/onboarding/ui'
import { useEffect, useRef, useState } from 'react'
import defaultTemplate from '../../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../../domain/tcm/templates/types'
import { draftEncounter as draftWithModel } from './core/drafting'
import type { Identity } from './core/identity'
import { MAX_PHOTOS, processPhoto } from './core/intake/photo'
import type { LlmClient } from './core/llm'
import { contactsForAlert, detectRegion, type RedFlagResult } from './core/redflags'
import { RECORD_COLLECTIONS } from './core/record/handover'
import {
  IN_PERSON_INTAKE_KEYS,
  InPersonUndeliveredError,
  addInPersonPhoto,
  inPersonConsultPackage,
  knownStudents,
  loadInPersonDraft,
  recordIntakeField,
  removeInPersonPhoto,
  retryInPersonHandover,
  saveInPersonDraft,
  signAndHandoverInPerson,
  startInPersonEncounter,
  type InPersonIntakeKey,
} from './core/record/in-person'
import { sendInPersonRecord, type SendEnvelope } from './core/inbox'
import type { Encounter } from './core/record/types'
import type { LocalStore } from './core/store'
import { SignEncounterPage } from './SignEncounterPage'
import './in-person.css'

const INTAKE_LABELS: Record<InPersonIntakeKey, string> = {
  chiefComplaint: '主诉',
  presentIllness: '现病史',
  history: '既往史',
  medsAllergies: '在吃的药、过敏',
}

function message(cause: unknown): string {
  return uiError(cause,'操作失败，请重试')
}

type Phase = 'select' | 'intake' | 'review' | 'sent'

export interface InPersonPageProps {
  store: LocalStore
  identity: Identity
  onBack: () => void
  // 有模型客户端时用 M1-10 起草；未配置时老师直接核对主诉后签字，流程不中断。
  send?: SendEnvelope
  llm?: LlmClient | null
}

// 老师端面诊记录：选定学生 → 当面代录主诉与病史（每项过急症红线，只提示不阻断）→ 当面拍照
// → 复用 M1-10 起草、M1-11 审改签字与诊毕即还。签字前所有内容只在本机。
export function InPersonPage({ store, identity, onBack, send: sendEnvelope, llm = null }: InPersonPageProps) {
  const [phase, setPhase] = useState<Phase>('select')
  const [encounter, setEncounter] = useState<Encounter | null>(null)
  const [draftEncounter, setDraftEncounter] = useState<Encounter | null>(null)
  const [studentInput, setStudentInput] = useState('')
  const [known, setKnown] = useState<string[]>([])
  const [redFlag, setRedFlag] = useState<RedFlagResult | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingEventId, setPendingEventId] = useState<string | null>(null)
  const [utterance,setUtterance]=useState('')
  const [questionIndex,setQuestionIndex]=useState(0)
  const [template,setTemplate]=useState<TeacherTemplate>(defaultTemplate)
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadTeacherTemplate(store).then(value=>{if(!cancelled)setTemplate(value)}).catch(()=>{})
    void knownStudents(store).then(rows => { if (!cancelled) setKnown(rows) }).catch(() => {})
    void loadInPersonDraft(store).then(saved => {
      if (cancelled || !saved) return
      // 恢复草稿时把代录文字再过一遍红线，避免上次会话漏掉的提示。
      let current = saved
      let hit: RedFlagResult | null = null
      for (const key of IN_PERSON_INTAKE_KEYS) {
        const value = saved.intake[key].value
        if (typeof value === 'string' && value !== '') {
          const result = recordIntakeField(current, key, value)
          current = result.encounter
          hit = hit ?? result.redFlag
        }
      }
      setEncounter(current)
      setRedFlag(hit)
      setPhase('intake')
      setStatus('已恢复上次未签字的面诊草稿，都还在本机。')
    }).catch(() => setError('本机草稿读取失败，可以重新新建。'))
    return () => { cancelled = true }
  }, [store])

  const apply = (next: Encounter, notice = '') => {
    setEncounter(next)
    setError('')
    if (notice) setStatus(notice)
    void saveInPersonDraft(store, next).catch(() => setError('草稿没有保存成功，请检查本机存储。'))
  }

  const begin = () => {
    setError('')
    const student = studentInput.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(student)) { setError('请填写学生的 身份编号。'); return }
    try {
      const next = startInPersonEncounter({ teacher: identity.publicKey, student })
      apply(next, '已新建面诊病历：签字之前，所有内容只在本机。')
      setPhase('intake')
    } catch (cause) { setError(message(cause)) }
  }

  const addFiles = async (files: FileList | null) => {
    if (!encounter || !files || busy) return
    setBusy(true); setError('')
    try {
      let next = encounter
      for (const file of Array.from(files)) {
        if (next.intake.attachments.length >= MAX_PHOTOS) break
        const bytes = new Uint8Array(await file.arrayBuffer())
        const result = await processPhoto({ bytes, type: file.type || 'image/jpeg' }, { existingCount: next.intake.attachments.length })
        // 处理后的字节单独存，签字交还成功后由 handover 一并删除。
        await store.put(RECORD_COLLECTIONS.attachments, result.ref.id, result.data)
        next = addInPersonPhoto(next, result.ref)
      }
      apply(next, '照片已在本机缩小，并去掉了位置等 EXIF 信息。')
    } catch (cause) { setError(message(cause)) } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const removePhoto = async (refId: string) => {
    if (!encounter || busy) return
    setBusy(true); setError('')
    try {
      await store.delete(RECORD_COLLECTIONS.attachments, refId)
      apply(removeInPersonPhoto(encounter, refId))
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const proceed = async () => {
    if (!encounter || busy) return
    setBusy(true); setError('')
    try {
      let drafted = encounter
      if (llm) {
        setStatus('正在整理草稿，老师看过整张卡片后签字发出。')
        let draftError = ''
        drafted = await draftWithModel(inPersonConsultPackage(encounter), await loadTeacherTemplate(store), [], llm, {level:'prescription',onError:message=>{draftError=message}})
        if(draftError)throw Error(draftError)
      } else {
        setStatus('未配置模型：本次没有 AI 草稿，判断与处理为空，核对主诉与照片后即可签字。')
      }
      setDraftEncounter(drafted)
      setPhase('review')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const send: import('./core/record/handover').SendSignedRecord = async (_type, payload) => {
    if (!sendEnvelope || !encounter) throw Error('暂未连接社区，请稍后重试，资料仍在本机。')
    await sendInPersonRecord(store, sendEnvelope, encounter.student, payload)
  }

  const addSentence = async () => {
    if (!encounter || !utterance.trim() || busy) return
    setBusy(true);setError('')
    try {
      const prior = encounter.intake
      const texts = [prior.chiefComplaint.value,prior.presentIllness.value].filter((v):v is string=>!!v)
      const focus = questionIndex > 0 ? (template as TeacherTemplate).focus[questionIndex-1] : undefined
      const answers:Record<string,string> = {}
      if(focus)answers[focus]=utterance
      else texts.push(utterance)
      // 共用学生端的原话摘取与固定追问回退；不让模型把代录变成老师判断。
      const outcome=await organizeIntake(null,{texts,focusAnswers:answers,focusOrder:template.focus,missingFocus:[],template})
      let next=encounter
      for(const key of IN_PERSON_INTAKE_KEYS){
        const value=outcome.fields[key].value
        if(value===null)continue
        const result=recordIntakeField(next,key,(key==='history'||key==='medsAllergies')&&prior[key].value ? prior[key].value+'\n'+value : value)
        next=result.encounter
        if(result.redFlag)setRedFlag(result.redFlag)
      }
      apply(next);setUtterance('');setQuestionIndex(i=>Math.min(i+1,template.focus.length+1))
    }catch(cause){setError(message(cause))}finally{setBusy(false)}
  }

  const confirm = async (finalEncounter: Encounter) => {
    if (!draftEncounter) return
    setError('')
    try {
      if (pendingEventId) {
        await retryInPersonHandover(store, pendingEventId, send)
        setPendingEventId(null)
      } else {
        await signAndHandoverInPerson({
          store,
          encounter: finalEncounter,
          draft: draftEncounter,
          privateKey: identity.privateKey,
          send,
        })
      }
      setPhase('sent')
    } catch (cause) {
      if (cause instanceof InPersonUndeliveredError) {
        setPendingEventId(cause.eventId)
        setError('未送达，可重发：原始资料仍在本机，签名事件已暂存。')
      } else {
        setError(message(cause))
      }
      throw cause
    }
  }

  if (phase === 'select') {
    return <main className="in-person-page">
      <header className="in-person-head">
        <button className="in-person-back" onClick={onBack}>返回</button>
        <h1>面诊工作台</h1>
        <p>学生到面前看诊：老师在自己手机上代录主诉、当面拍照，签字后照常交还给学生。签字之前，所有内容只在本机。</p>
      </header>
      {error && <p role="alert" className="in-person-error">{error}</p>}
      {status && <p role="status" className="in-person-status">{status}</p>}
      <section className="in-person-card">
        <h2>选定学生</h2>
        {known.length===0?<p>还没有可选学生，请先在管理页邀请学生，让学生发送一次问诊。</p>:<label>选择学生<select value={studentInput} onChange={e=>setStudentInput(e.target.value)}><option value="">请选择</option>{known.map((person,i)=><option key={person} value={person}>学生 {i+1}</option>)}</select></label>}
        <div className="in-person-actions">
          <button className="in-person-primary" disabled={busy || !studentInput} onClick={begin}>新建面诊病历</button>
        </div>
      </section>
    </main>
  }

  if (phase === 'sent') {
    return <main className="in-person-page">
      <header className="in-person-head"><h1>已签字交还</h1></header>
      <section className="in-person-card in-person-done">
        <p>签名病历已加密发给学生。</p>
        <p className="in-person-note">按诊毕即还：这次的照片和代录原文已从老师端删除，只保留时间、病历 id 与去标识医案。</p>
        <div className="in-person-actions"><button onClick={onBack}>返回</button></div>
      </section>
    </main>
  }

  if (phase === 'review' && draftEncounter) {
    return <>
      {error && <p role="alert" className="in-person-error">{error}</p>}
      <SignEncounterPage
        onRevise={llm ? (current,instruction)=>reviseEncounter(current,instruction,llm) : undefined}
        initial={draftEncounter}
        onConfirm={confirm}
        onCancel={() => { setPhase('intake'); setStatus('已返回录入页，内容都还在本机。') }}
      />
    </>
  }

  if (!encounter) return null
  const photos = encounter.intake.attachments
  return <main className="in-person-page">
    <header className="in-person-head">
      <button className="in-person-back" onClick={onBack}>返回</button>
      <h1>面诊录入</h1>
      <p>当面听学生说，补充情况后整理病历。</p>
    </header>
    {error && <p role="alert" className="in-person-error">{error}</p>}
    {status && <p role="status" className="in-person-status">{status}</p>}
    {redFlag && <section className="in-person-alert" role="alert">
      <h2>请尽快去医院</h2>
      {redFlag.actions.includes('crisis') && contactsForAlert(redFlag,detectRegion(navigator.language)).filter(item=>item.action==='crisis').map(item=><p key={item.contact.number}>心理援助：{item.contact.number} · {item.contact.name}</p>)}
      <p>这段描述命中了本地急症红线{redFlag.matched.length > 0 ? '：' + redFlag.matched.join('、') : ''}。老师在现场，记录可以继续，由老师判断。</p>
      <div className="in-person-actions"><button type="button" onClick={() => setRedFlag(null)}>我已知晓</button></div>
    </section>}
    <section className="in-person-card">
      <h2>说说哪里不舒服</h2>
      {IN_PERSON_INTAKE_KEYS.map(key=>encounter.intake[key].value&&<p key={key}>{INTAKE_LABELS[key]}：{encounter.intake[key].value}</p>)}
      {questionIndex>0&&questionIndex<=template.focus.length&&<p>再问一句：{fixedQuestions([template.focus[questionIndex-1]])[0]?.text ?? template.focus[questionIndex-1]}</p>}
      <form onSubmit={e=>{e.preventDefault();void addSentence()}}><label>用输入法的语音输入，或直接打字<textarea rows={3} maxLength={2000} value={utterance} disabled={busy} onChange={e=>setUtterance(e.target.value)}/></label><button disabled={busy||!utterance.trim()}>加入这一句</button>{questionIndex>0&&questionIndex<=template.focus.length&&<button type="button" disabled={busy} onClick={()=>setQuestionIndex(i=>i+1)}>跳过</button>}</form>
    </section>
    <section className="in-person-card">
      <h2>当面拍照（舌象等，最多 {MAX_PHOTOS} 张）</h2>
      <p className="in-person-note">在本机缩小到长边 ≤1600 像素、去掉位置等 EXIF 信息后放进病历；签字交还后老师端删除。</p>
      {photos.length > 0 && <ul className="in-person-photos">
        {photos.map(item => <li key={item.id}><span>照片 · {Math.ceil(item.bytes / 1024)} KB</span><button type="button" onClick={() => void removePhoto(item.id)}>移除</button></li>)}
      </ul>}
      <input ref={fileInput} type="file" accept="image/*" capture="environment" multiple onChange={event => void addFiles(event.target.files)} />
    </section>
    <footer className="in-person-actions">
      <button className="in-person-primary" disabled={busy || !encounter.intake.chiefComplaint.value || !!utterance.trim()} onClick={() => void proceed()}>生成病历</button>
      <button onClick={onBack}>返回</button>
    </footer>
  </main>
}
