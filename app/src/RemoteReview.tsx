import { useEffect, useRef, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { Encounter, Prescription } from './core/record/types'
import {
  assertConsultReady, completeConsultSigning, consultChargeBook, consultReadiness, draftPackage, INBOX_COLLECTIONS,
  listStudentAdherence, type ConsultReadiness, type LedgerRecorder, type SendEnvelope, type StoredConsult, type StudentAdherence,
} from './core/inbox'
import { toMinor, moneyCurrencyFor } from './core/ledger/money'
import { recordSignedObservation, type ObservationNote } from './core/kangbi'
import { calculateMetric, saveMetric, rateMetric } from './core/pilot'
import { teacherCases, teacherRecordsOf, type LoadedTeacherRecord } from './core/records/teacher'
import { loadTeacherTemplate } from './core/drafting/template'
import { draftEncounter } from './core/drafting'
import { priorMaterials } from './core/drafting/materials'
import { reviseEncounter } from './core/drafting/revise'
import { TonguePair } from './TonguePair'
import { TeacherCarePlan } from './TeacherCarePlan'
import { parseTongueAbstract, type TongueAbstract } from '../../domain/tcm/tongue'
import { managedLabel } from './core/family'
import { weekStart } from './core/adherence'
import { localDay } from './core/homework/schedule'
import { uiError } from './core/onboarding/ui'
import { SignReview } from './SignReview'
import './newui.css'

// V2-16 远程问诊：从“等您签字”一行点进来，用同一个核对签字页。
// 附件到齐才起草；扣费、舌象逐项改值、14 天走势和调养方案放在“本次资料”里，不挤占核对页。
export interface RemoteReviewProps {
  identity: Identity
  store: LocalStore
  consult: StoredConsult
  llm: LlmClient | null
  send: SendEnvelope
  ledger?: LedgerRecorder
  onExit: () => void
}

function message(cause: unknown): string { return uiError(cause, '操作失败，请重试') }

function MiniTrend({ trend }: { trend: { days: string[]; scores: (number | null)[]; stress: (number | null)[] } }) {
  const dots = (values: (number | null)[]) => values.map(value => (value === null ? '·' : String(value))).join(' ')
  return <div>
    <p className="nl-quiet">状态 {dots(trend.scores)}</p>
    <p className="nl-quiet">压力 {dots(trend.stress)}</p>
  </div>
}

export function RemoteReview({ identity, store, consult, llm, send, ledger, onExit }: RemoteReviewProps) {
  const startedAt = useRef(Date.now()), signedAt = useRef<number | null>(null), metricKey = useRef('')
  const [draft, setDraft] = useState<Encounter | null>(null)
  const [materialNote, setMaterialNote] = useState<string[]>([])
  const [previous, setPrevious] = useState<LoadedTeacherRecord | null>(null)
  const [tongues, setTongues] = useState<TongueAbstract[] | null>(null)
  const [charge, setCharge] = useState('')
  const [currency, setCurrency] = useState('')
  const [comparison, setComparison] = useState<ObservationNote>(null)
  const [adherence, setAdherence] = useState<StudentAdherence | null>(null)
  const [readiness, setReadiness] = useState<ConsultReadiness | null>(null)
  const [done, setDone] = useState(false)
  const [ratingKey, setRatingKey] = useState<string | null>(null)
  const [ratingBusy, setRatingBusy] = useState(false)
  const [busy, setBusy] = useState(true)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        // 试点指标：一次问诊一个键；签字后按这个键保存并让老师评分。
        startedAt.current = Date.now()
        metricKey.current = crypto.randomUUID()
        const state = await consultReadiness(store, consult.encounter.id)
        if (active) setReadiness(state)
        if (!state.ready) { setStatus('附件还在路上，到齐后才能起草。'); return }
        const ready = await assertConsultReady(store, consult.encounter.id)
        const book = consultChargeBook(consult)
        const [reports, rows, currentCurrency] = await Promise.all([
          listStudentAdherence(store),
          teacherRecordsOf(store, consult.encounter.student),
          moneyCurrencyFor(store, identity.publicKey, book?.student ?? consult.encounter.student),
        ])
        if (!active) return
        setAdherence(reports.find(report => report.student === (consult.sender ?? consult.encounter.student)) ?? null)
        setPrevious(rows.at(0) ?? null)
        setCurrency(currentCurrency ?? '')
        const pkg = draftPackage(ready)
        let next: Encounter
        if (llm) {
          setStatus('正在整理草稿，老师看过整张卡片后签字发出。')
          let draftError = ''
          // V2-19：只带这位学生、这件事的材料；旧病历可减，模板与问诊包不可减。
          const result = await draftEncounter(pkg, {
            template: await loadTeacherTemplate(store),
            prior: priorMaterials(rows),
            cases: await teacherCases(store, { forStudent: consult.encounter.student }),
          }, llm, { level: 'prescription', onError: text => { draftError = text } })
          if (draftError) throw Error(draftError)
          if (!active) return
          setMaterialNote(result.note)
          next = result.encounter
          setStatus('草稿尚未签字，改稿不会自动发出。')
        } else {
          setStatus('未配置模型：没有 AI 草稿，核对问诊资料后直接签字。')
          if (active) setMaterialNote([])
          next = structuredClone(ready.encounter)
        }
        const heaven = ready.heaven ?? ready.encounter.heaven
        if (heaven && !next.heaven) next = { ...next, heaven: { ...heaven } }
        if (!active) return
        setDraft(next)
        setTongues(next.intake.tongues?.length ? next.intake.tongues.map(record => parseTongueAbstract(record)) : null)
      } catch (cause) {
        if (active) setError(message(cause))
      } finally {
        if (active) setBusy(false)
      }
    })()
    return () => { active = false }
  }, [store, consult, identity.publicKey, llm])

  const currentReport = (): StudentAdherence | null => {
    if (!adherence) return null
    return adherence.weekStart === weekStart(localDay(new Date())) ? adherence : null
  }

  const confirm = async (final: Encounter, chosen?: ObservationNote) => {
    if (!draft) return
    setError(''); setStatus('')
    try {
      const signedFinal: Encounter = tongues && final.intake.tongues
        ? { ...final, intake: { ...final.intake, tongues: tongues.map(record => parseTongueAbstract(record)) } }
        : final
      const amount = charge.trim() === '' ? undefined : toMinor(charge.trim(), currency)
      signedAt.current ??= Date.now()
      const metric = calculateMetric(draft, signedFinal, startedAt.current, signedAt.current, currentReport()?.weeklyRate ?? null)
      const chargeBook = consultChargeBook(consult)
      const result = await completeConsultSigning({
        identity, store, consult, final: signedFinal, draft, send, ledger,
        charge: amount, currency, ...(chargeBook ? { chargeBook } : {}),
      })
      if (result.chargeError) setStatus('已签字交还；扣费没有记上：' + result.chargeError)
      else setStatus('已签字交还。')
      try { await saveMetric(store, metricKey.current, metric); setRatingKey(metricKey.current) }
      catch { setStatus(previousText => previousText + ' 试点指标未能保存，不影响已交还病历。') }
      try {
        await recordSignedObservation(store, {
          id: result.signed.id, student: consult.encounter.student, teacher: identity.publicKey,
          at: new Date(signedAt.current!), teacherMinutes: Math.max(0, (signedAt.current! - startedAt.current) / 60000),
          consultations: 1, teacherNote: chosen ?? null, report: consult.observation ?? null,
        })
      } catch { /* 观察记录暂未保存不影响已交还病历 */ }
      setDone(true)
    } catch (cause) {
      signedAt.current = null
      throw cause
    }
  }

  if (done) {
    return <div className="nl-shell"><div className="nl-page nl-signed">
      <h1>已签字交还</h1>
      <p className="nl-quiet">学生已收到这份签名病历；作业会自动进入学生的“今日作业”。</p>
      <p className="nl-quiet">问诊包与附件仍在本机；记录删除按老师设定的保留期限统一处理。</p>
      {status && <p role="status" className="nl-quiet">{status}</p>}
      {error && <p role="alert" className="nl-danger-strong">{error}</p>}
      {ratingKey && <section role="dialog" aria-label="像不像我评分" className="nl-card">
        <h2>这份草案像不像我？</h2><p className="nl-quiet">1～5 分，可跳过；只记录分数。</p>
        <div className="nl-tabs">
          {[1, 2, 3, 4, 5].map(score => <button key={score} type="button" disabled={ratingBusy} onClick={() => {
            setRatingBusy(true)
            void rateMetric(store, ratingKey, score).then(() => setRatingKey(null)).catch(() => setError('评分未保存，请重试或跳过。')).finally(() => setRatingBusy(false))
          }}>{score}分</button>)}
        </div>
        <button type="button" disabled={ratingBusy} onClick={() => setRatingKey(null)}>跳过评分</button>
      </section>}
      <button type="button" className="nl-primary" onClick={onExit}>返回今天</button>
    </div></div>
  }

  if (busy || !draft) {
    return <div className="nl-shell"><header className="nl-flow-head">
      <button type="button" className="nl-back" aria-label="返回" onClick={onExit}>‹</button>
      <div><h1>核对</h1><small>正在读取这次问诊…</small></div>
    </header><div className="nl-flow-body">
      {error && <p role="alert" className="nl-danger-strong">{error}</p>}
      {status && <p role="status" className="nl-quiet">{status}</p>}
      {readiness && !readiness.ready && <p className="nl-empty">附件 {readiness.arrived}/{readiness.total} · 附件还在路上</p>}
      {error && <button type="button" className="nl-primary" onClick={onExit}>返回今天</button>}
    </div></div>
  }

  const alias = managedLabel(consult.encounter.profile)
  const previousPrescription: Prescription | null = previous?.encounter.plan.prescription.value ?? null
  const extras = <>
    {status && <p role="status" className="nl-quiet">{status}</p>}
    {error && <p role="alert" className="nl-danger-strong">{error}</p>}
    <label className="nl-quiet">本次扣费（可选，{currency || '请先在管理页设置钱账币种'}）
      <input type="text" inputMode="decimal" value={charge} onChange={event => setCharge(event.target.value)} placeholder="不填就不扣" />
    </label>
    <p className="nl-quiet">签字交还成功后，由老师端账本记一笔扣费；不填就不扣。</p>
    {tongues?.map((record, index) => {
      const candidate = consult.encounter.intake.tongues?.[index]
      return <TonguePair key={'tongue-' + index} record={record} {...(candidate ? { candidate } : {})} editable
        title={`舌象 ${index + 1} · ${record.shichen}时 · ${record.jieqi} · ${record.city}`}
        loadCrop={async () => {
          const id = record.crop?.id
          if (!id) return null
          const data = await store.get(INBOX_COLLECTIONS.attachments, id)
          return data instanceof Uint8Array ? data : null
        }}
        missingCropState="expired"
        onChange={next => setTongues(list => list ? list.map((item, i) => i === index ? next : item) : list)} />
    })}
    {consult.trend && <><h3>最近 14 天状态与压力</h3><MiniTrend trend={consult.trend} /></>}
    <h3>这位学生的调养方案</h3>
    <TeacherCarePlan identity={identity} store={store} student={consult.sender} llm={llm} send={send} />
  </>

  return <SignReview
    encounter={draft}
    alias={alias}
    subtitle="四诊已记好 · 下面是智能体的草稿"
    materialNote={materialNote}
    previousPrescription={previousPrescription}
    previousEventId={previous?.eventId ?? null}
    comparison={comparison}
    onComparisonChange={setComparison}
    onSign={final => confirm(final, comparison)}
    onBack={onExit}
    onRevise={llm ? (current, instruction) => reviseEncounter(current, instruction, llm) : undefined}
    extras={extras}
  />
}
