import { useEffect, useState } from 'react'
import template from '../../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../../domain/tcm/templates/types'
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
import { intakeDisplayLabel } from './core/record/in-person'
import type { Encounter } from './core/record/types'
import type { LlmClient } from './core/llm'
import type { LocalStore } from './core/store'
import { SignEncounterPage } from './SignEncounterPage'
import './inbox.css'

const INTAKE_LABELS = {
  chiefComplaint: '主诉',
  presentIllness: '现病史',
  history: '既往史',
  medsAllergies: '在吃的药、过敏',
} as const

function textField(field: { value: string | null } | undefined): string {
  return field && field.value !== null && field.value !== '' ? field.value : '未知'
}

function message(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '操作失败，请重试'
}

export interface TeacherInboxPageProps {
  identity: Identity
  store: LocalStore
  onBack: () => void
  send: SendEnvelope
  ledger?: LedgerRecorder
  llm?: LlmClient | null
}

// 老师端问诊箱：列出收到的问诊包；照片到齐才能起草，缺照片时显示“照片还在路上”。
// 起草复用 M1-10，审改签字与交还复用 M1-11，扣费走 M1-14b 的账本记录。
export function TeacherInboxPage({ identity, store, onBack, send, ledger, llm = null }: TeacherInboxPageProps) {
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
    setConsults(rows)
    const map: Record<string, ConsultReadiness> = {}
    for (const consult of rows) map[consult.encounter.id] = await consultReadiness(store, consult.encounter.id)
    setReadiness(map)
  }

  useEffect(() => {
    let cancelled = false
    void refresh().catch(() => { if (!cancelled) setError('无法读取本机问诊箱，请稍后重试。') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  const startDraft = async (consult: StoredConsult) => {
    setBusy(true); setError(''); setStatus('')
    try {
      const ready = await assertConsultReady(store, consult.encounter.id)
      const pkg = draftPackage(ready)
      let next: Encounter
      if (llm) {
        setStatus('正在起草：AI 推测会逐项标为“AI 草稿”，老师采用或修改后才能签字。')
        next = await draftEncounter(pkg, template as TeacherTemplate, [], llm, { level: 'prescription' })
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
      const result = pendingEventId
        ? await retryConsultHandover({ store, eventId: pendingEventId, send, ledger, charge: amount, teacher: identity.publicKey, student: selected.sender })
        : await completeConsultSigning({ identity, store, consult: selected, draft: draft ?? final, final, send, ledger, charge: amount })
      setPendingEventId(null)
      if (result.chargeError) setStatus('病历已交还；扣费没有记上：' + result.chargeError)
      else setStatus('已签字交还，原始资料已从老师端删除。')
      setDone(true)
    } catch (cause) {
      if (cause instanceof ConsultUndeliveredError) setPendingEventId(cause.eventId)
      throw cause
    }
  }

  if (done) {
    return <main className="inbox-page">
      <header className="inbox-head"><h1>已签字交还</h1></header>
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
      <SignEncounterPage
        initial={draft}
        onConfirm={confirm}
        onCancel={() => {
          setSelected(null); setDraft(null); setPendingEventId(null)
          void refresh().catch(() => setError('问诊箱刷新失败，请稍后重试。'))
        }}
      />
    </>
  }

  if (selected) {
    const status = readiness[selected.encounter.id]
    const total = status?.total ?? selected.attachments.length
    const arrived = status?.arrived ?? 0
    return <main className="inbox-page">
      <header className="inbox-head">
        <button className="inbox-back" onClick={() => { setSelected(null); setError('') }}>返回</button>
        <h1>问诊详情</h1>
        <p>学生 {selected.sender.slice(0, 8)}… · {new Date(selected.receivedAt).toLocaleString()}</p>
      </header>
      {error && <p role="alert" className="inbox-error">{error}</p>}
      {status && !status.ready && <section className="inbox-alert"><h2>照片还在路上（{arrived}/{total}）</h2><p>照片到齐后才能起草，避免只看到一半资料就写病历。</p></section>}
      <section className="inbox-card">
        <h2>主诉与病史</h2>
        {(Object.keys(INTAKE_LABELS) as (keyof typeof INTAKE_LABELS)[]).map(key => <div className="inbox-field" key={key}>
          <p className="inbox-label">{INTAKE_LABELS[key]} <span className="inbox-source">{intakeDisplayLabel(selected.encounter, key)}</span></p>
          <p className="inbox-value">{textField(selected.encounter.intake[key])}</p>
        </div>)}
      </section>
      <section className="inbox-card">
        <h2>照片</h2>
        <p>{total === 0 ? '没有附照片。' : '已到 ' + arrived + ' / ' + total + ' 张（老师端只保留处理后、去 EXIF 的字节）。'}</p>
      </section>
      <section className="inbox-card">
        <h2>附带的历史病历</h2>
        <p>{selected.history.length === 0 ? '没有附带历史病历。' : '已附带 ' + selected.history.length + ' 份，全部验签通过。'}</p>
        {selected.droppedHistory > 0 && <p className="inbox-note">另有 {selected.droppedHistory} 份没有通过验签，已丢弃，不会用于起草。</p>}
      </section>
      <footer className="inbox-actions">
        <button className="inbox-primary" disabled={busy || !status?.ready} onClick={() => void startDraft(selected)}>起草并审改</button>
        <button onClick={onBack}>返回首页</button>
      </footer>
    </main>
  }

  return <main className="inbox-page">
    <header className="inbox-head">
      <button className="inbox-back" onClick={onBack}>返回</button>
      <h1>问诊箱</h1>
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
        <h2>{textField(consult.encounter.intake.chiefComplaint)}</h2>
        <p className="inbox-meta">学生 {consult.sender.slice(0, 8)}… · {new Date(consult.receivedAt).toLocaleString()}</p>
        <p className={state?.ready ? 'inbox-status' : 'inbox-error'}>照片 {arrived}/{total}{state?.ready ? '' : ' · 照片还在路上'}</p>
        <div className="inbox-actions"><button onClick={() => { setSelected(consult); setError('') }}>查看</button></div>
      </article>
    })}
  </main>
}
