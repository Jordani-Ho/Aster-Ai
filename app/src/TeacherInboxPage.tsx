import { loadTeacherTemplate } from './core/drafting/template'
import { reviseEncounter } from './core/drafting/revise'
import { prioritizeConsults, urgentConsult } from './core/inbox/priority'
import {uiError} from './core/onboarding/ui'
import { calculateMetric, saveMetric, rateMetric } from './core/pilot'
import { useEffect, useRef, useState } from 'react'
import { draftEncounter } from './core/drafting'
import type { Identity } from './core/identity'
import {
  ConsultUndeliveredError,
  assertConsultReady,
  completeConsultSigning,
  consultReadiness,
  draftPackage,
  listConsults,
  retryConsultHandover,
  type ConsultReadiness,
  type LedgerRecorder,
  type SendEnvelope,
  type StoredConsult,
} from './core/inbox'
import type { Encounter } from './core/record/types'
import type { LlmClient } from './core/llm'
import type { LocalStore } from './core/store'
import { SignEncounterPage } from './SignEncounterPage'
import './inbox.css'

function textField(field: { value: string | null } | undefined): string {
  return field && field.value !== null && field.value !== '' ? field.value : '未知'
}

function message(cause: unknown): string {
  return uiError(cause,'操作失败，请重试')
}

export interface TeacherInboxPageProps {
  identity: Identity
  store: LocalStore
  onBack: () => void
  send: SendEnvelope
  ledger?: LedgerRecorder
  renderCarePlan?: (student: string) => import('react').ReactNode
  llm?: LlmClient | null
}

// 老师端问诊箱：列出收到的问诊包；照片到齐才能起草，缺照片时显示“照片还在路上”。
// 起草复用 M1-10，审改签字与交还复用 M1-11，扣费走 M1-14b 的账本记录。
export function TeacherInboxPage({ identity, store, onBack, send, ledger, renderCarePlan, llm = null }: TeacherInboxPageProps) {
  const startedAt = useRef(0), signedAt = useRef<number | null>(null), metricKey = useRef('')
  const [ratingKey, setRatingKey] = useState<string | null>(null)
  const [ratingBusy, setRatingBusy] = useState(false)
  const [consults, setConsults] = useState<StoredConsult[]>([])
  const [readiness, setReadiness] = useState<Record<string, ConsultReadiness>>({})
  const [selected, setSelected] = useState<StoredConsult | null>(null)
  const [draft, setDraft] = useState<Encounter | null>(null)
  const [charge, setCharge] = useState('')
  const [pendingEventId, setPendingEventId] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  const refresh = async () => {
    const rows = await listConsults(store)
    setConsults(prioritizeConsults(rows))
    const map: Record<string, ConsultReadiness> = {}
    for (const consult of rows) map[consult.encounter.id] = await consultReadiness(store, consult.encounter.id)
    setReadiness(map)
  }

  useEffect(() => {
    let cancelled = false
    void refresh().catch(() => { if (!cancelled) setError('无法读取本机问诊箱，请稍后重试。') })
      .finally(() => { if (!cancelled) setLoading(false) })
    const changed = () => { void refresh().catch(() => {}) }
    window.addEventListener('aster:data-changed', changed)
    return () => { cancelled = true; window.removeEventListener('aster:data-changed', changed) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  const startDraft = async (consult: StoredConsult) => {
    startedAt.current = Date.now(); signedAt.current = null; metricKey.current = crypto.randomUUID(); setRatingKey(null)
    setBusy(true); setError(''); setStatus('')
    try {
      const ready = await assertConsultReady(store, consult.encounter.id)
      const pkg = draftPackage(ready)
      let next: Encounter
      if (llm) {
        setStatus('正在整理草稿，老师看过整张卡片后签字发出。')
        let draftError = ''
        next = await draftEncounter(pkg, await loadTeacherTemplate(store), [], llm, { level: 'prescription', onError: message => { draftError = message } })
        if (draftError) throw Error(draftError)
        setStatus('草稿尚未签字，改稿不会自动发出。')
      } else {
        setStatus('未配置模型：没有 AI 草稿，请核对问诊资料后直接签字（判断与处理为空）。')
        next = structuredClone(ready.encounter)
      }
      setSelected(ready)
      setDraft(next)
      setCharge('')
      setPendingEventId(null)
      setDone(false)
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const confirm = async (final: Encounter) => {
    if (!selected) return
    const amount = charge.trim() === '' ? undefined : Number(charge)
    setError(''); setStatus('')
    try {
      if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0)) throw Error('扣费金额必须是正整数')
      signedAt.current ??= Date.now()
      const metric = calculateMetric(draft ?? final, final, startedAt.current, signedAt.current)
      const result = pendingEventId
        ? await retryConsultHandover({ store, eventId: pendingEventId, send, ledger, charge: amount, teacher: identity.publicKey, student: selected.sender })
        : await completeConsultSigning({ identity, store, consult: selected, draft: draft ?? final, final, send, ledger, charge: amount })
      setPendingEventId(null)
      if (result.chargeError) setStatus('病历已交还；扣费没有记上：' + result.chargeError)
      else setStatus('已签字交还，原始资料已从老师端删除。')
      try { await saveMetric(store, metricKey.current, metric); setRatingKey(metricKey.current) }
      catch { setStatus(previous => previous + ' 试点指标未能保存，不影响已交还病历。') }
      setSelected(null); setDraft(null)
      setDone(true)
    } catch (cause) {
      if (cause instanceof ConsultUndeliveredError) setPendingEventId(cause.eventId)
      else if (!pendingEventId) signedAt.current = null
      throw cause
    }
  }

  if (done) {
    return <main className="inbox-page">
      <header className="inbox-head"><h1>已签字交还</h1></header>
      {ratingKey && <section role="dialog" aria-label="像不像我评分" className="inbox-card">
        <h2>这份草案像不像我？</h2><p>1～5分，可跳过；只记录分数。</p>
        {[1,2,3,4,5].map(score => <button key={score} disabled={ratingBusy} onClick={() => {
          setRatingBusy(true)
          void rateMetric(store, ratingKey, score).then(() => setRatingKey(null)).catch(() => setError('评分未保存，请重试或跳过。')).finally(() => setRatingBusy(false))
        }}>{score}分</button>)}<button disabled={ratingBusy} onClick={() => setRatingKey(null)}>跳过评分</button>
        {error && <p role="alert">{error}</p>}
      </section>}
      <section className="inbox-card">
        <p>学生已收到这份签名病历；作业会自动进入学生的“今日作业”。</p>
        <p className="inbox-note">按诊毕即还：问诊包与照片已从老师端删除，本地只留索引、去标识医案与修改记录。</p>
        {status && <p role="status" className="inbox-status">{status}</p>}
        <div className="inbox-actions"><button onClick={() => { setDone(false); setSelected(null); setDraft(null); void refresh() }}>返回问诊箱</button><button onClick={onBack}>返回首页</button></div>
      </section>
    </main>
  }

  if (selected && draft) {
    return <>
      <div className="inbox-charge">
        <label>本次扣费（可选，康币）<input type="number" min={1} step={1} inputMode="numeric" value={charge} onChange={event => setCharge(event.target.value)} placeholder="不填就不扣" /></label>
        <p className="inbox-note">签字交还成功后，由老师端账本记一笔扣费；不填就不扣。</p>
        {status && <p role="status" className="inbox-status">{status}</p>}
        {error && <p role="alert" className="inbox-error">{error}</p>}
      </div>
      <section className="inbox-card"><h2>这位学生的调养方案</h2>{renderCarePlan ? renderCarePlan(selected.sender) : <p>调养方案正在接入，暂未开放。</p>}</section>
      <SignEncounterPage
        initial={draft}
        onConfirm={confirm}
        onRevise={llm ? (encounter, instruction) => reviseEncounter(encounter, instruction, llm) : undefined}
        onCancel={() => {
          setSelected(null); setDraft(null); setPendingEventId(null)
          void refresh().catch(() => setError('问诊箱刷新失败，请稍后重试。'))
        }}
      />
    </>
  }

  return <main className="inbox-page">
    <header className="inbox-head">
      <button className="inbox-back" onClick={onBack}>返回</button>
      <h1>远程工作台</h1>
      <p>学生确认发送后才会出现。照片到齐才能起草；签字交还后原始资料会从老师端删除。</p>
    </header>
    {error && <p role="alert" className="inbox-error">{error}</p>}
    {status && <p role="status" className="inbox-status">{status}</p>}
    {loading && <p className="inbox-note">正在读取问诊箱…</p>}
    {!loading && consults.length === 0 && <p className="inbox-note">还没有收到问诊。学生点“确认发送”后会出现在这里。</p>}
    {consults.map(consult => {
      const state = readiness[consult.encounter.id]
      const total = state?.total ?? consult.attachments.length
      const arrived = state?.arrived ?? 0
      return <article className="inbox-card" key={consult.encounter.id}>
        {urgentConsult(consult) && <p className="inbox-alert" role="note">急症提醒 · 请优先查看</p>}<h2>{textField(consult.encounter.intake.chiefComplaint)}</h2>
        <p className="inbox-meta">学生 {consult.sender.slice(0, 8)}… · {new Date(consult.receivedAt).toLocaleString()}</p>
        <p className={state?.ready ? 'inbox-status' : 'inbox-error'}>照片 {arrived}/{total}{state?.ready ? '' : ' · 照片还在路上'}</p>
        <div className="inbox-actions"><button disabled={busy || !state?.ready} onClick={() => void startDraft(consult)}>打开问诊</button></div>
      </article>
    })}
  </main>
}
