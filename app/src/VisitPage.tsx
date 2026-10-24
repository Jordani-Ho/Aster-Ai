import { useEffect, useRef, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { Encounter } from './core/record/types'
import {
  inPersonConsultPackage, knownStudents, loadInPersonDraft, recordIntakeField,
  saveInPersonDraft, signAndHandoverInPerson, startInPersonEncounter, type SendSignedRecord,
} from './core/record/in-person'
import { sendInPersonRecord, listStudentAdherence, type SendEnvelope, type StudentAdherence } from './core/inbox'
import { teacherCases, teacherRecordsOf, type LoadedTeacherRecord } from './core/records/teacher'
import { loadTeacherTemplate } from './core/drafting/template'
import { draftWithAgent } from './core/drafting/agent'
import { priorMaterials } from './core/drafting/materials'
import { reviseEncounter } from './core/drafting/revise'
import { recordSignedObservation, type ObservationNote } from './core/kangbi'
import { formatHeavenTime, heavenNow, heavenStampOf, type HeavenTime } from './core/heaven'
import { EXAM_KEYS, splitFourExams, type ExamKey } from './four-exams'
import { confirmHeardExams, setExamDraft } from './review-model'
import { SignReview } from './SignReview'
import { PostureTool } from './PostureTool'
import { uiError } from './core/onboarding/ui'
import './newui.css'

// V2-16 面诊进行中（02）：选学生 → 老师说一段、智能体拆进望闻问切四格 → 说完了看草稿。
// 起草仍复用 M1-10，签字仍复用 M1-11 的面诊路径；不做应用内语音识别，话筒只是聚焦输入框。
export interface VisitPageProps {
  identity: Identity
  store: LocalStore
  llm: LlmClient | null
  send?: SendEnvelope
  /** 从“学生”标签点某位学生直接开始面诊。 */
  initialStudent?: string
  onExit: () => void
}

type Phase = 'select' | 'dictate' | 'review' | 'sent'

const EXAM_ORDER: readonly ExamKey[] = EXAM_KEYS

function message(cause: unknown): string { return uiError(cause, '操作失败，请重试') }

function aliasOf(records: readonly LoadedTeacherRecord[]): string {
  const value = records.at(0)?.encounter.profile.alias.value
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

export function VisitPage({ identity, store, llm, send: sendEnvelope, initialStudent, onExit }: VisitPageProps) {
  const [phase, setPhase] = useState<Phase>('select')
  const [students, setStudents] = useState<string[]>([])
  const [records, setRecords] = useState<LoadedTeacherRecord[]>([])
  const [adherence, setAdherence] = useState<StudentAdherence[]>([])
  const [savedDraft, setSavedDraft] = useState<Encounter | null>(null)
  const [encounter, setEncounter] = useState<Encounter | null>(null)
  const [draft, setDraft] = useState<Encounter | null>(null)
  const [materialNote, setMaterialNote] = useState<string[]>([])
  const [previous, setPrevious] = useState<LoadedTeacherRecord | null>(null)
  const [utterance, setUtterance] = useState('')
  const [heaven, setHeaven] = useState<HeavenTime | null>(null)
  const [editingExam, setEditingExam] = useState<ExamKey | null>(null)
  const [examText, setExamText] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [comparison, setComparison] = useState<ObservationNote>(null)
  const [postureOpen, setPostureOpen] = useState(false)
  const textarea = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([knownStudents(store), listStudentAdherence(store), loadInPersonDraft(store), heavenNow(store)])
      .then(([people, reports, draftRow, time]) => {
        if (!active) return
        setStudents(people); setAdherence(reports); setSavedDraft(draftRow); setHeaven(time)
        if (initialStudent && people.includes(initialStudent)) void start(initialStudent)
      }).catch(() => { if (active) setError('本机资料读取失败，请稍后重试。') })
    return () => { active = false }
  }, [store])

  const start = async (student: string) => {
    setBusy(true); setError('')
    try {
      const [rows, time] = await Promise.all([teacherRecordsOf(store, student), heavenNow(store)])
      const next = startInPersonEncounter({ teacher: identity.publicKey, student, heaven: heavenStampOf(time) })
      setRecords(rows); setPrevious(rows.at(0) ?? null); setEncounter(next); setHeaven(time); setDraft(null)
      setMaterialNote([]); setComparison(null); setUtterance(''); setStatus(''); setPhase('dictate')
      await saveInPersonDraft(store, next)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const resume = async () => {
    if (!savedDraft) return
    setBusy(true); setError('')
    try {
      const rows = await teacherRecordsOf(store, savedDraft.student)
      setRecords(rows); setPrevious(rows.at(0) ?? null); setEncounter(savedDraft); setPhase('dictate')
      setStatus('已读回上次未签字的面诊草稿，都还在本机。')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const apply = (next: Encounter, notice = '') => {
    setEncounter(next); setError('')
    if (notice) setStatus(notice)
    void saveInPersonDraft(store, next).catch(() => setError('草稿没有保存成功，请检查本机存储。'))
  }

  // “整理”这一段：智能体拆进望闻问切四格（模型失败用本地关键词拆分），同时把原话记进主诉/现病史。
  const organize = async () => {
    if (!encounter || busy) return
    const text = utterance.trim()
    if (text === '') return
    setBusy(true); setError('')
    try {
      const { fragments, usedModel } = await splitFourExams(text, llm)
      let next = encounter
      for (const key of EXAM_ORDER) {
        const added = fragments[key]
        if (added.length === 0) continue
        next = setExamDraft(next, key, added.join('；'))
      }
      // 老师代录：第一句作主诉，后面的补进现病史（V2-18：不做急症判断）。
      const chief = next.intake.chiefComplaint.value
      if (chief === null || chief === '') {
        next = recordIntakeField(next, 'chiefComplaint', text)
      } else {
        const prior = next.intake.presentIllness.value
        next = recordIntakeField(next, 'presentIllness', prior ? prior + '\n' + text : text)
      }
      apply(next, usedModel ? '已把这一段拆进四格，逐格确认后可改。' : '模型暂不可用，已按关键词拆进四格，可逐格修改。')
      setUtterance('')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const startExamEdit = (key: ExamKey) => {
    setEditingExam(key); setExamText(encounter?.fourExams[key].value ?? '')
  }

  const saveExam = () => {
    if (!encounter || editingExam === null) return
    const next: Encounter = {
      ...encounter,
      fourExams: { ...encounter.fourExams, [editingExam]: { value: examText.trim() === '' ? null : examText, source: 'teacher', note: 'heard' } },
    }
    apply(next); setEditingExam(null)
  }

  const toReview = async () => {
    if (!encounter || busy) return
    setBusy(true); setError(''); setStatus('')
    try {
      const confirmed = confirmHeardExams(encounter)
      let drafted = confirmed
      if (llm) {
        setStatus('正在整理草稿，老师看过整张卡片后签字发出。')
        let draftError = ''
        const generated = await draftWithAgent(store, inPersonConsultPackage(confirmed), {
          template: await loadTeacherTemplate(store),
          // V2-19：这位学生以前签过字的旧病历（可减）；医案只取老师亲手改过的（可减）。
          prior: priorMaterials(records),
          cases: await teacherCases(store, { forStudent: confirmed.student }),
        }, llm, { level: 'prescription', onError: text => { draftError = text } })
        if (draftError) throw Error(draftError)
        setMaterialNote(generated.note)
        // 老师自己说、自己确认过的四诊优先于模型从主诉里推的四诊。
        drafted = {
          ...generated.encounter,
          fourExams: Object.fromEntries(EXAM_ORDER.map(key => [key, confirmed.fourExams[key].value !== null ? confirmed.fourExams[key] : generated.encounter.fourExams[key]])) as Encounter['fourExams'],
        }
      } else {
        setStatus('未配置模型：本次没有 AI 草稿，核对四诊后即可签字。')
        setMaterialNote([])
      }
      // V2-30：体态记录不经过模型起草，核对面诊草稿时原样带进签字。
      if (confirmed.postures?.length) drafted = { ...drafted, postures: confirmed.postures }
      apply(confirmed)
      setDraft(drafted); setPhase('review')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const confirm = async (final: Encounter, chosen?: ObservationNote) => {
    if (!draft || !encounter) return
    const sendRecord: SendSignedRecord = async (_type, payload) => {
      if (!sendEnvelope) throw Error('暂未连接社区，请稍后重试，资料仍在本机。')
      await sendInPersonRecord(store, sendEnvelope, encounter.student, payload)
    }
    try {
      const signed = await signAndHandoverInPerson({ encounter: final, privateKey: identity.privateKey, send: sendRecord, store, draft })
      try {
        await recordSignedObservation(store, {
          id: signed.id, student: final.student, teacher: identity.publicKey, at: new Date(),
          teacherMinutes: 0, consultations: 1, teacherNote: chosen ?? null, report: null,
        })
      } catch { /* 观察记录暂未保存不影响已交还病历 */ }
      setPhase('sent')
    } catch (cause) { throw cause }
  }

  if (phase === 'sent') {
    return <div className="nl-shell"><div className="nl-page nl-signed">
      <h1>已签字交还</h1>
      <p className="nl-quiet">签名病历已发给学生。照片与代录内容仍在本机，按保留期限统一清理。</p>
      <button type="button" className="nl-primary" onClick={onExit}>返回今天</button>
    </div></div>
  }

  if (postureOpen && encounter) {
    return <PostureTool identity={identity} store={store} student={encounter.student} encounter={encounter}
      onClose={() => setPostureOpen(false)}
      onChangePostures={list => apply({ ...encounter, postures: list })}
      onAddHomework={homework => apply({ ...encounter, plan: { ...encounter.plan, homework: [...encounter.plan.homework, homework] } }, '已把动作加进这次面诊的作业草稿。')} />
  }

  if (phase === 'review' && draft && encounter) {
    const alias = aliasOf(records) || '这位学生'
    return <SignReview
      encounter={draft}
      alias={alias}
      subtitle={llm ? '四诊已记好 · 下面是智能体的草稿' : '四诊已记好 · 核对后签字'}
      materialNote={materialNote}
      comparison={comparison}
      onComparisonChange={setComparison}
      onSign={final => confirm(final, comparison)}
      onBack={() => setPhase('dictate')}
      onRevise={llm ? (current, instruction) => reviseEncounter(current, instruction, llm) : undefined}
    />
  }

  if (phase === 'dictate' && encounter) {
    const alias = aliasOf(records) || '这位学生'
    const report = adherence.find(item => item.student === encounter.student)
    const lastPattern = previous?.encounter.judgment.pattern.value
    const lastPrescription = previous?.encounter.plan.prescription.value?.items.map(item => item.herb).join('、')
    const lastHomework = previous?.encounter.plan.homework.map(item => item.title).join('、')
    return <div className="nl-shell">
      <header className="nl-flow-head">
        <button type="button" className="nl-back" aria-label="返回" onClick={onExit}>‹</button>
        <div><h1>{alias}</h1><small>{[
          [previous?.encounter.profile.gender.value === 'male' ? '男' : previous?.encounter.profile.gender.value === 'female' ? '女' : '', previous?.encounter.profile.age.value ? previous.encounter.profile.age.value + ' 岁' : ''].filter(Boolean).join(' · '),
          '第 ' + (new Set(records.map(row => row.encounterId)).size + 1) + ' 次面诊',
          heaven ? formatHeavenTime(heaven) : '',
          heaven ? heaven.jieqi : '',
          heaven?.city ?? '',
        ].filter(Boolean).join(' · ')}</small></div>
      </header>
      <div className="nl-flow-body">
        {error && <p role="alert" className="nl-danger-strong">{error}</p>}
        {(lastPattern || lastPrescription || lastHomework) && <details className="nl-visit-last">
          <summary>{'上次' + (previous ? ' ' + new Date(previous.encounter.createdAt).toLocaleDateString() : '')}</summary>
          {lastPattern && <p>证候：{lastPattern}</p>}
          {lastPrescription && <p>方子：{lastPrescription}</p>}
          {lastHomework && <p>作业：{lastHomework}</p>}
          {report && <p className="nl-quiet">这周练习 {report.practiceDays} 天{report.streak > 0 ? ' · 已连续 ' + report.streak + ' 天' : ''}</p>}
        </details>}

        <section className="nl-listen" aria-label="口述记录">
          <div className="nl-listen-head"><span className="nl-listen-dot" aria-hidden="true" />正在听 · 您说，智能体记</div>
          <textarea ref={textarea} rows={3} maxLength={2000} value={utterance} disabled={busy} aria-label="您说，智能体记"
            placeholder="用输入法的语音输入，或直接打字。说一段，点“整理”。" onChange={event => setUtterance(event.target.value)} />
          <div className="nl-listen-actions">
            <button type="button" disabled={busy || !utterance.trim()} onClick={() => void organize()}>整理</button>
            <span className="nl-help">{status}</span>
          </div>
        </section>

        <div className="nl-exams">
          {EXAM_ORDER.map(key => {
            const field = encounter.fourExams[key]
            const heard = field.source === 'ai_draft'
            const source = field.source === 'student' ? '学生说的' : heard ? '听到了，待您确认' : field.value !== null ? '您说的' : ''
            return <div key={key} className={'nl-exam' + (heard ? ' heard' : '')} role="button" tabIndex={0}
              aria-label={'四诊 ' + key} onClick={() => startExamEdit(key)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startExamEdit(key) } }}>
              <div className="nl-exam-head"><strong>{key === 'look' ? '望' : key === 'listenSmell' ? '闻' : key === 'ask' ? '问' : '切'}</strong>{source && <small>{source}</small>}</div>
              {editingExam === key
                ? <textarea rows={3} value={examText} aria-label={key === 'look' ? '望' : key === 'listenSmell' ? '闻' : key === 'ask' ? '问' : '切'}
                  onClick={event => event.stopPropagation()} onChange={event => setExamText(event.target.value)} />
                : <p className={field.value === null ? 'placeholder' : undefined}>{field.value ?? (heard ? '待确认' : '点一下填写')}</p>}
              {editingExam === key && <div onClick={event => event.stopPropagation()}>
                <button type="button" onClick={saveExam}>就这样</button>
              </div>}
            </div>
          })}
        </div>
        <p className="nl-help">点任意一格可以改。说完四诊，智能体按您以往的思想起草判断和方子。</p>
        <button type="button" className="nl-link-button" onClick={() => setPostureOpen(true)}>体态：拍一段 / 导入骨架（这次 {encounter.postures?.length ?? 0} 条）</button>
      </div>
      <footer className="nl-visit-foot">
        <button type="button" className="nl-mic" aria-label="话筒：唤起语音输入" onClick={() => { textarea.current?.focus() }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V22h2v-3.1A7 7 0 0 0 19 12h-2Z" /></svg>
        </button>
        <button type="button" className="nl-primary" disabled={busy || encounter.intake.chiefComplaint.value === null} onClick={() => void toReview()}>说完了，看草稿</button>
      </footer>
    </div>
  }

  const pendingDraftStudent = savedDraft?.student ?? ''
  return <div className="nl-shell">
    <header className="nl-flow-head">
      <button type="button" className="nl-back" aria-label="返回" onClick={onExit}>‹</button>
      <div><h1>开始面诊</h1><small>选一位学生，或扫他手机上的码</small></div>
    </header>
    <div className="nl-flow-body">
      {error && <p role="alert" className="nl-danger-strong">{error}</p>}
      {students.length === 0 && <p className="nl-empty">还没有学生。先在“我的馆 → 邀请学生”请学生进来。</p>}
      <ul className="nl-list">
        {students.map((student, index) => <li key={student}>
          <button type="button" className="nl-row" disabled={busy} onClick={() => void start(student)}>
            <span className="nl-avatar" aria-hidden="true">{index + 1}</span>
            <span className="nl-row-main"><strong>{'学生 ' + (index + 1)}</strong><span>{student === pendingDraftStudent ? '有一份未签字的面诊草稿' : '点一下开始这次面诊'}</span></span>
          </button>
        </li>)}
      </ul>
      {savedDraft && <button type="button" className="nl-primary" disabled={busy} onClick={() => void resume()}>继续上次未签字的面诊</button>}
    </div>
  </div>
}
