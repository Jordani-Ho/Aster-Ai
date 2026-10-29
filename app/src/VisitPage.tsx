import { useEffect, useRef, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { Encounter } from './core/record/types'
import {
  inPersonConsultPackage, knownStudents, loadInPersonDraft, recordIntakeField,
  saveInPersonDraft, startInPersonEncounter, type SendSignedRecord,
} from './core/record/in-person'
import { signAndHandoverInPersonWithHerbs } from './core/record/in-person-herbs'
import { sendInPersonRecord, listStudentAdherence, type SendEnvelope, type StudentAdherence } from './core/inbox'
import { teacherCases, teacherRecordsOf, type LoadedTeacherRecord } from './core/records/teacher'
import { loadTeacherTemplate } from './core/drafting/template'
import { draftWithAgent } from './core/drafting/agent'
import { priorMaterials } from './core/drafting/materials'
import { reviseEncounter } from './core/drafting/revise'
import { recordSignedObservation, type ObservationNote } from './core/kangbi'
import { formatHeavenTime, heavenNow, heavenStampOf, type HeavenTime } from './core/heaven'
import { EXAM_KEYS, type ExamKey } from './four-exams'
import { confirmHeardExams } from './review-model'
import { SignReview } from './SignReview'
import { PostureTool } from './PostureTool'
import { VisitRecorder } from './VisitRecorder'
import { VisitAudioPlayer } from './VisitAudioPlayer'
import { VisitPhotos } from './VisitPhotos'
import { TongueCapture } from './TongueCapture'
import { TonguePair } from './TonguePair'
import { loadVisitOriginals, editVisitOriginal, appendVisitOriginal, type VisitOriginal } from './core/record/visit-originals'
import { organizeVisitSegment } from './core/intake/visit-organizer'
import { clearVisitRawMaterials } from './core/record/visit-cleanup'
import { VISIT_ORGANIZATION_KEYS, validateVisitOrganization, mergeVisitOrganization, emptyVisitOrganization, type VisitOrganization } from './core/record/visit-organization'
import { uiError } from './core/onboarding/ui'
import { prescriptionStockNotes } from './core/herbs'
import './newui.css'

// 面诊中录音、本机保存原话，供老师核对整理草稿后签字。
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
  const encounterRef = useRef<Encounter | null>(null)
  encounterRef.current = encounter
  const [draft, setDraft] = useState<Encounter | null>(null)
  const [materialNote, setMaterialNote] = useState<string[]>([])
  const [previous, setPrevious] = useState<LoadedTeacherRecord | null>(null)
  const [utterance, setUtterance] = useState('')
  const [recording, setRecording] = useState(false)
  const [stopRequest, setStopRequest] = useState(0)
  const exitAfterStop = useRef(false)
  const [audioRevision, setAudioRevision] = useState(0)
  const [cleanupPending, setCleanupPending] = useState(false)
  const [originals, setOriginals] = useState<VisitOriginal[]>([])
  const [visitOrganization, setVisitOrganization] = useState<VisitOrganization | null>(null)
  const [heaven, setHeaven] = useState<HeavenTime | null>(null)
  const [editingExam, setEditingExam] = useState<ExamKey | null>(null)
  const [examText, setExamText] = useState('')
  const [status, setStatus] = useState('')
  const [postSignNotice, setPostSignNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [comparison, setComparison] = useState<ObservationNote>(null)
  const [postureOpen, setPostureOpen] = useState(false)
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const originalEditQueue = useRef<Promise<void>>(Promise.resolve())

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
      const basics = await store.get('teacher-student-basics', student) as { alias: string; gender: 'male' | 'female' | 'other'; age: number; bazi: typeof next.profile.bazi.value; city: string; at: number } | undefined
      const roster = await store.get('teacher-students', student) as { city?: string | null; cityUpdatedAt?: number } | undefined
      if (basics) for (const key of ['alias', 'gender', 'age', 'bazi', 'city'] as const) {
        const value = key === 'city' && typeof roster?.cityUpdatedAt === 'number' && roster.cityUpdatedAt > basics.at ? roster.city ?? null : basics[key]
        Object.assign(next.profile[key], { value, source: value === null ? 'unknown' : 'student' })
      }
      setRecords(rows); setPrevious(rows.at(0) ?? null); setEncounter(next); setHeaven(time); setDraft(null)
      setMaterialNote([]); setComparison(null); setVisitOrganization(null); setUtterance(''); setStatus(''); setPostSignNotice(''); setPhase('dictate')
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
    encounterRef.current = next; setEncounter(next); setError('')
    if (notice) setStatus(notice)
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => saveInPersonDraft(store, next))
    void saveQueue.current.catch(() => setError('草稿没有保存成功，请检查本机存储。'))
  }

  // 打字内容同样编号，交给本馆模板整理，不按句子顺序猜主诉。
  const organize = async () => {
    if (!encounter || busy || !utterance.trim()) return
    setBusy(true); setError('')
    try {
      await appendVisitOriginal(store, encounter.id, utterance.trim())
      setUtterance(''); refreshOriginals()
      await organizeRecording()
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const refreshOriginals = () => { if (encounter) void loadVisitOriginals(store, encounter.id).then(setOriginals).catch(() => setError('原话读取失败，请重试。')) }
  useEffect(() => {
    if (!encounter) { setOriginals([]); setVisitOrganization(null); return }
    let active = true
    void Promise.all([loadVisitOriginals(store, encounter.id), store.get('visit-organized', encounter.id)]).then(([lines, saved]) => { if (active) { setOriginals(lines); setVisitOrganization(saved && typeof saved === 'object' && !Array.isArray(saved) ? validateVisitOrganization((saved as {organized?:unknown}).organized, lines) : null) } }).catch(() => { if (active) setError('原话读取失败，请重试。') })
    return () => { active = false }
  }, [store, encounter?.id])
  const organizeRecording = async () => {
    if (!encounter) return
    setBusy(true); setError(''); setStatus('正在整理录音原话…')
    try {
      await originalEditQueue.current
      const lines = await loadVisitOriginals(store, encounter.id)
      if (!lines.length) { setStatus('没有识别出文字，可以直接打字。'); return }
      const saved = await store.get('visit-organized', encounter.id) as {organized?:unknown;through?:unknown} | undefined
      const prior = saved ? validateVisitOrganization(saved.organized, lines) : null
      const through = prior && Number.isSafeInteger(saved?.through) && (saved!.through as number) <= lines.length ? saved!.through as number : 0
      if (through === lines.length) { setStatus('这一段已经整理过。'); return }
      const result = await organizeVisitSegment(llm, lines, through, await loadTeacherTemplate(store))
      const combined = mergeVisitOrganization(prior ?? emptyVisitOrganization(), result.organized, [])
      if (!validateVisitOrganization(combined, lines)) throw Error('整理内容过长，请先核对并精简。')
      await store.put('visit-organized', encounter.id, {organized: combined, through:lines.length} as unknown as import('./core/store').StoreValue)
      setVisitOrganization(combined)
      const current = encounterRef.current
      if (current && current.id === encounter.id) {
        let next = structuredClone(current)
        for (const key of ['chiefComplaint', 'presentIllness'] as const) {
          const value = combined[key].text
          if (value && (next.intake[key].source === 'unknown' || next.intake[key].source === 'ai_draft')) next.intake[key] = {value,source:'ai_draft',note:'heard'}
        }
        for (const key of EXAM_ORDER) {
          const value = combined[key].text
          if (value && (next.fourExams[key].source === 'unknown' || next.fourExams[key].source === 'ai_draft')) next.fourExams[key] = {value,source:'ai_draft',note:'heard'}
        }
        apply(next)
      }
      setStatus(result.usedModel ? '已整理成草稿，请逐栏核对原话。' : '模型暂不可用，已按关键词整理，请逐栏核对原话。')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  const exitVisit = () => {
    if (!recording) { onExit(); return }
    if (window.confirm('正在录音，离开会停止录音并整理原话。确定离开吗？')) { exitAfterStop.current = true; setStopRequest(value => value + 1) }
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
      let notes: string[] = []
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
        notes = generated.note
        // 老师自己说、自己确认过的四诊优先于模型从主诉里推的四诊。
        drafted = {
          ...generated.encounter,
          fourExams: Object.fromEntries(EXAM_ORDER.map(key => [key, confirmed.fourExams[key].value !== null ? confirmed.fourExams[key] : generated.encounter.fourExams[key]])) as Encounter['fourExams'],
        }
      } else {
        setStatus('未配置模型：本次没有 AI 草稿，核对四诊后即可签字。')
      }
      // V2-30：体态记录不经过模型起草，核对面诊草稿时原样带进签字。
      if (confirmed.postures?.length) drafted = { ...drafted, postures: confirmed.postures }
      if (drafted.plan.prescription.value?.items.length) {
        try { notes = [...notes, ...await prescriptionStockNotes(store, drafted.plan.prescription.value.items)] }
        catch { notes = [...notes, '库存暂时无法核对，不影响继续起草。'] }
      }
      setMaterialNote(notes)
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
      // 等待草稿写入结束，避免签后清理与尚未完成的写入交错。
      await originalEditQueue.current
      await saveQueue.current
      const { signed, inventoryNotice } = await signAndHandoverInPersonWithHerbs({ encounter: final, privateKey: identity.privateKey, send: sendRecord, store, draft })
      try {
        await recordSignedObservation(store, {
          id: signed.id, student: final.student, teacher: identity.publicKey, at: new Date(),
          teacherMinutes: 0, consultations: 1, teacherNote: chosen ?? null, report: null,
        })
      } catch { /* 观察记录暂未保存不影响已交还病历 */ }
      let cleanupNotice = ''
      try { await clearVisitRawMaterials(store, final); setCleanupPending(false) } catch { setCleanupPending(true); cleanupNotice = '本机原始材料未能全部清除，请重试清理。' }
      setPostSignNotice([inventoryNotice, cleanupNotice].filter(Boolean).join(' '))
      setPhase('sent')
    } catch (cause) { throw cause }
  }

  if (phase === 'sent') {
    return <div className="nl-shell"><div className="nl-page nl-signed">
      <h1>已签字交还</h1>
      <p className="nl-quiet">签名病历已发给学生。</p>
      {postSignNotice && <p role="status" className="nl-quiet">{postSignNotice}</p>}
      {cleanupPending && encounter && <button type="button" onClick={() => { void clearVisitRawMaterials(store, encounter).then(() => { setCleanupPending(false); setPostSignNotice('本机原始材料已清除。') }).catch(() => setPostSignNotice('仍未能清除，请检查本机存储后重试。')) }}>重试清理</button>}
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
    const alias = encounter.profile.alias.value || aliasOf(records) || '这位学生'
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
    const alias = encounter.profile.alias.value || aliasOf(records) || '这位学生'
    const report = adherence.find(item => item.student === encounter.student)
    const gender = encounter.profile.gender.value ?? previous?.encounter.profile.gender.value
    const age = encounter.profile.age.value ?? previous?.encounter.profile.age.value
    const lastPattern = previous?.encounter.judgment.pattern.value
    const lastPrescription = previous?.encounter.plan.prescription.value?.items.map(item => item.herb).join('、')
    const lastHomework = previous?.encounter.plan.homework.map(item => item.title).join('、')
    return <div className="nl-shell">
      <header className="nl-flow-head">
        <button type="button" className="nl-back" aria-label="返回" onClick={exitVisit}>‹</button>
        <div><h1>{alias}</h1><small>{[
          [gender === 'male' ? '男' : gender === 'female' ? '女' : '', age != null ? age + ' 岁' : ''].filter(Boolean).join(' · '),
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

        <VisitRecorder key={encounter.id} store={store} visitId={encounter.id} onChange={refreshOriginals} onRecording={setRecording} stopRequest={stopRequest} onStopped={() => { setAudioRevision(value => value + 1); void organizeRecording().then(() => { if (exitAfterStop.current) { exitAfterStop.current = false; onExit() } }) }} />
        <VisitAudioPlayer store={store} visitId={encounter.id} revision={audioRevision} />
        {originals.length > 0 && <section className="nl-card" aria-label="逐句原话"><h2>逐句原话</h2>{originals.map(line => <label key={line.id}>第 {line.id} 句{line.edited ? ' · 老师改' : ''}<textarea defaultValue={line.text} onBlur={event => { if (event.target.value !== line.text) { const text = event.target.value; originalEditQueue.current = originalEditQueue.current.catch(() => {}).then(async () => { await editVisitOriginal(store, encounter.id, line.id, text); await store.delete('visit-organized', encounter.id); setVisitOrganization(null); refreshOriginals() }); void originalEditQueue.current.catch(() => setError('原话没有保存，请检查内容后重试。')) } }} /></label>)}<button type="button" disabled={busy || recording} onClick={() => void organizeRecording()}>重新整理原话</button></section>}
        {visitOrganization && <section className="nl-card" aria-label="录音整理草稿"><h2>录音整理 · 待您确认</h2>{VISIT_ORGANIZATION_KEYS.map(key => {
          const field = visitOrganization[key]
          if (!field.text) return null
          const label = {chiefComplaint:'主诉',presentIllness:'现病史',look:'望',listenSmell:'闻',ask:'问',pulse:'切'}[key]
          return <div key={key}><strong>{label} · 草稿</strong><p>{field.text}</p><small>依据：{field.citations.map(id => '第 ' + id + ' 句').join('、')}</small><button type="button" onClick={() => {
            if (key === 'chiefComplaint' || key === 'presentIllness') apply(recordIntakeField(encounter, key, field.text!))
            else apply({ ...encounter, fourExams: { ...encounter.fourExams, [key]: { value: field.text, source: 'teacher', note: 'heard' } } })
          }}>采用这一栏</button></div>
        })}</section>}
        <section className="nl-listen" aria-label="口述记录">
          <div className="nl-listen-head"><span className="nl-listen-dot" aria-hidden="true" />正在听 · 您说，智能体记</div>
          <textarea ref={textarea} rows={3} maxLength={2000} value={utterance} disabled={busy} aria-label="您说，智能体记"
            placeholder="用输入法的语音输入，或直接打字。说一段，点“整理”。" onChange={event => setUtterance(event.target.value)} />
          <div className="nl-listen-actions">
            <button type="button" disabled={busy || !utterance.trim()} onClick={() => void organize()}>整理</button>
            <span className="nl-help">{status}</span>
          </div>
        </section>

        <section className="nl-card" aria-label="面诊基本记录">
          <label>主诉{encounter.intake.chiefComplaint.source === 'ai_draft' && ' · 草稿，待您确认'}<textarea aria-label="主诉" value={encounter.intake.chiefComplaint.value ?? ''} onChange={event => apply(recordIntakeField(encounter, 'chiefComplaint', event.target.value))} /></label>
          <label>现病史{encounter.intake.presentIllness.source === 'ai_draft' && ' · 草稿，待您确认'}<textarea aria-label="现病史" value={encounter.intake.presentIllness.value ?? ''} onChange={event => apply(recordIntakeField(encounter, 'presentIllness', event.target.value))} /></label>
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
        <section aria-label="望诊照片"><h2>望诊照片</h2>
          <TongueCapture store={store} cityOverride={encounter.profile.city.value} disabled={busy || (encounter.intake.tongues?.length ?? 0) >= 1} onCaptured={async (tongue, _at, crop) => {
            if (!tongue.crop || encounter.intake.attachments.length >= 4) throw Error('照片已满，请先删除一张。')
            await store.put('attachments', tongue.crop.id, crop)
            apply({ ...encounter, intake: { ...encounter.intake, tongues: [...(encounter.intake.tongues ?? []), tongue], attachments: [...encounter.intake.attachments, tongue.crop] } })
          }} />
          {encounter.intake.tongues?.map((tongue,index)=><TonguePair key={index} record={tongue} title="本次舌象" loadCrop={async()=>{const id=tongue.crop?.id;if(!id)return null;const data=await store.get('attachments',id);return data instanceof Uint8Array?data:null}} missingCropState="missing" />)}
          <VisitPhotos store={store} encounter={encounter} onChange={next => apply(next)} />
        </section>
        <p className="nl-help">点任意一格可以改。说完四诊，智能体按您以往的思想起草判断和方子。</p>
        <button type="button" className="nl-link-button" onClick={() => setPostureOpen(true)}>体态：拍一段 / 导入骨架（这次 {encounter.postures?.length ?? 0} 条）</button>
      </div>
      <footer className="nl-visit-foot">
        <button type="button" className="nl-mic" aria-label="话筒：唤起语音输入" onClick={() => { textarea.current?.focus() }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V22h2v-3.1A7 7 0 0 0 19 12h-2Z" /></svg>
        </button>
        <button type="button" className="nl-primary" disabled={busy || recording || encounter.intake.chiefComplaint.value === null || encounter.intake.chiefComplaint.source === 'ai_draft' || encounter.intake.presentIllness.source === 'ai_draft'} onClick={() => void toReview()}>说完了，看草稿</button>
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
