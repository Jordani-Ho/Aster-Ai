import { useState, type ReactNode } from 'react'
import type { Encounter, Homework, Prescription } from './core/record/types'
import type { ObservationChoice } from './core/kangbi'
import { OBSERVATION_CHOICES } from './core/kangbi'
import { acceptDraftForSigning } from './core/record/sign'
import { isLongRecord } from './core/record/fold'
import { EXAM_LABELS, EXAM_KEYS, type ExamKey } from './four-exams'
import {
  changeReasonText, confirmBlock, confirmHeardExams, pendingBlockCount, pendingDraftCount,
  prescriptionChangeReasonNeeded, reviewBlocks, setHomeworkItems, setPrescription, setTextField,
  type ReviewBlock, type ReviewBlockKey,
} from './review-model'

// V2-16 核对签字（面诊/远程共用）：一块一块摆出来，草稿是黄虚线，每块“改一改 / 就这样”；
// 还有草稿时“签字发出”灰着。签字本身仍走 core/record/sign（AI 路径不参与签字）。
const FIELD_LABELS: Record<string, string> = { 'judgment.symptomSummary': '摘要', 'judgment.pattern': '证候', 'judgment.mechanism': '病机', 'judgment.rationale': '辨证依据', 'plan.principle': '治法', 'plan.advice': '医嘱' }
const EXAM_PLACEHOLDER: Record<ExamKey, string> = { look: '看到的面色、舌象…', listenSmell: '听到的声音、气味…', ask: '问到的症状…', pulse: '脉象、按诊…' }

function scheduleLabel(spec: Homework['schedule']): string {
  switch (spec.kind) {
    case 'daily': return '每天 ' + spec.time
    case 'shichen': return spec.shichen + '时'
    case 'jieqi': return spec.jieqi
    case 'once': return spec.date + (spec.time ? ' ' + spec.time : '')
    case 'habit': return '随习惯：' + spec.anchor
  }
}

function heroTag(block: ReviewBlock, hasPrevious: boolean): string {
  if (!block.pending) return '已确认'
  if (block.key === 'prescription') return hasPrevious ? '草稿 · 照您上次加减' : '草稿 · 智能体整理'
  return '草稿 · 智能体整理'
}

export interface SignReviewProps {
  encounter: Encounter
  alias: string
  subtitle?: string
  /** V2-19：这次起草减了材料时的提示行（不悄悄少带），一行没减就不传。 */
  materialNote?: string[]
  /** 上一次签字的方子（改方时比对“去了什么、加了什么”）。 */
  previousPrescription?: Prescription | null
  previousEventId?: string | null
  comparison?: ObservationChoice | null
  onComparisonChange?: (value: ObservationChoice | null) => void
  onSign: (encounter: Encounter) => Promise<void> | void
  onBack: () => void
  /** 让智能体按一句话改草稿（保留 M1-10 的改稿能力，默认收起）。 */
  onRevise?: (encounter: Encounter, instruction: string) => Promise<Encounter>
  /** 远程问诊的本次资料：扣费、舌象、14 天走势、调养方案。 */
  extras?: ReactNode
}

export function SignReview({
  encounter, alias, subtitle, materialNote, previousPrescription = null, previousEventId = null,
  comparison = null, onComparisonChange, onSign, onBack, onRevise, extras,
}: SignReviewProps) {
  const [current, setCurrent] = useState<Encounter>(encounter)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<ReviewBlockKey | 'fourExams' | null>(null)
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [herbs, setHerbs] = useState('')
  const [method, setMethod] = useState('')
  const [days, setDays] = useState('')
  const [reason, setReason] = useState('')
  const [items, setItems] = useState<Homework[]>([])
  const [instruction, setInstruction] = useState('')
  const [revising, setRevising] = useState(false)
  const [openBlocks, setOpenBlocks] = useState<Record<string, boolean>>({})

  const longRecord = isLongRecord(current)
  const blocks = reviewBlocks(current)
  const examPending = EXAM_KEYS.some(key => current.fourExams[key].source === 'ai_draft')
  const pending = pendingBlockCount(current)
  const changeReasonNeeded = prescriptionChangeReasonNeeded(previousPrescription, current.plan.prescription.value)
  const diffText = changeReasonText(previousPrescription, current.plan.prescription.value)

  const startEdit = (key: ReviewBlockKey | 'fourExams') => {
    setError(''); setEditing(key)
    if (key === 'fourExams') {
      setTexts(Object.fromEntries(EXAM_KEYS.map(exam => ['fourExams.' + exam, current.fourExams[exam].value ?? ''])))
      return
    }
    if (key === 'judgment') {
      setTexts({
        'judgment.symptomSummary': current.judgment.symptomSummary.value ?? '',
        'judgment.pattern': current.judgment.pattern.value ?? '',
        'judgment.mechanism': current.judgment.mechanism.value ?? '',
        'judgment.rationale': current.judgment.rationale.value ?? '',
        'plan.principle': current.plan.principle.value ?? '',
      })
      return
    }
    if (key === 'prescription') {
      setHerbs((current.plan.prescription.value?.items ?? []).map(item => item.herb + ' ' + item.dose).join('\n'))
      setMethod(current.plan.prescription.value?.method ?? '')
      setDays(current.plan.prescription.value?.days ? String(current.plan.prescription.value.days) : '')
      setReason(current.plan.prescription.value?.changeReason ?? '')
      return
    }
    if (key === 'homework') { setItems(current.plan.homework.map(item => ({ ...item }))); return }
    setTexts({ 'plan.advice': current.plan.advice.value ?? '' })
  }

  const saveTexts = () => {
    let next = current
    for (const [path, value] of Object.entries(texts)) next = setTextField(next, path, value)
    setCurrent(next); setEditing(null)
  }

  const savePrescription = () => {
    const list = herbs.split(/\n+/).map(line => line.trim()).filter(Boolean).map(line => {
      const match = line.match(/^(.*?)\s+(\S+)$/)
      return match ? { herb: match[1].trim(), dose: match[2].trim() } : { herb: line, dose: '' }
    })
    if (list.some(item => item.herb === '' || item.dose === '')) { setError('每行写“药材 剂量”，剂量不能空着。'); return }
    const parsedDays = days.trim() === '' ? undefined : Number(days)
    if (parsedDays !== undefined && (!Number.isInteger(parsedDays) || parsedDays <= 0)) { setError('天数写正整数，或留空。'); return }
    const next: Prescription = { items: list, ...(method.trim() ? { method: method.trim() } : {}), ...(parsedDays ? { days: parsedDays } : {}) }
    if (prescriptionChangeReasonNeeded(previousPrescription, next) && reason.trim() === '') { setError('改了方子，请写一句理由。'); return }
    setCurrent(setPrescription(current, next, { reason: reason.trim(), previousEventId: previousEventId ?? undefined }))
    setError(''); setEditing(null)
  }

  const saveHomework = () => {
    if (items.some(item => item.title.trim() === '' || item.detail.trim() === '')) { setError('作业标题和说明都不能空着。'); return }
    setCurrent(setHomeworkItems(current, items.map(item => ({ ...item, title: item.title.trim(), detail: item.detail.trim() }))))
    setError(''); setEditing(null)
  }

  const confirmPrescription = () => {
    if (changeReasonNeeded && reason.trim() === '') { setError('改了方子，请写一句理由。'); return }
    let next = current
    if (changeReasonNeeded && current.plan.prescription.value) {
      next = setPrescription(next, current.plan.prescription.value, { reason: reason.trim(), previousEventId: previousEventId ?? undefined })
    }
    setCurrent(confirmBlock(next, 'prescription'))
    setError('')
  }

  const sign = async () => {
    if (busy || pendingDraftCount(current) > 0) return
    setBusy(true); setError('')
    try { await onSign(acceptDraftForSigning(current)) }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : '签字发出没有完成，资料仍在本机，请重试。') }
    finally { setBusy(false) }
  }

  const revise = async () => {
    if (!onRevise || revising || instruction.trim() === '') return
    setRevising(true); setError('')
    try { setCurrent(await onRevise(current, instruction.trim())); setInstruction('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '改稿未完成，请重试。') }
    finally { setRevising(false) }
  }

  const blockBody = (block: ReviewBlock) => {
    if (editing === block.key) return <EditFields block={block} texts={texts} setTexts={setTexts} herbs={herbs} setHerbs={setHerbs}
      method={method} setMethod={setMethod} days={days} setDays={setDays} reason={reason} setReason={setReason}
      items={items} setItems={setItems} changeReasonNeeded={changeReasonNeeded} diffText={diffText}
      onSave={() => block.key === 'prescription' ? savePrescription() : block.key === 'homework' ? saveHomework() : saveTexts()}
      onCancel={() => setEditing(null)} />
    return <>
      {block.key === 'prescription'
        ? <PrescriptionBody block={block} diffText={diffText} />
        : block.key === 'homework'
          ? <HomeworkBody items={block.items} />
          : <TextBody block={block} />}
      {block.pending && <div className="nl-block-actions">
        <button type="button" className="nl-secondary" onClick={() => startEdit(block.key)}>改一改</button>
        <button type="button" className="nl-primary" onClick={() => block.key === 'prescription' ? confirmPrescription() : setCurrent(confirmBlock(current, block.key))}>就这样</button>
      </div>}
      {block.pending && block.key === 'prescription' && changeReasonNeeded && <>
        <p className="nl-diff">{diffText}。改了要写一句理由。</p>
        <label className="nl-quiet">改方理由<input value={reason} maxLength={200} onChange={event => setReason(event.target.value)} placeholder="例如：睡不实，加远志安神" /></label>
      </>}
      {!block.pending && <button type="button" className="nl-secondary" onClick={() => startEdit(block.key)}>改一改</button>}
    </>
  }

  const examBlock = examPending && <details className="nl-review-block draft" aria-label="四诊" open={longRecord ? openBlocks.fourExams ?? true : true}
    onToggle={event => { const open = event.currentTarget.open; setOpenBlocks(previous => ({ ...previous, fourExams: open })) }}>
    <summary><h2>四诊</h2><span className="nl-tag draft">草稿 · 听到了，待您确认</span></summary>
    {editing === 'fourExams'
      ? <div className="nl-edit">
        {EXAM_KEYS.map(exam => <label key={exam}>{EXAM_LABELS[exam]}<textarea rows={2} value={texts['fourExams.' + exam] ?? ''} placeholder={EXAM_PLACEHOLDER[exam]}
          onChange={event => setTexts(previous => ({ ...previous, ['fourExams.' + exam]: event.target.value }))} /></label>)}
        <div className="nl-edit-actions"><button type="button" className="nl-secondary" onClick={() => setEditing(null)}>先不改</button><button type="button" className="nl-primary" onClick={() => saveTexts()}>改成这样</button></div>
      </div>
      : <>
        {EXAM_KEYS.filter(exam => current.fourExams[exam].value !== null).map(exam => <div className="nl-review-field" key={exam}>
          <small>{EXAM_LABELS[exam]}</small><p>{current.fourExams[exam].value}</p>
        </div>)}
        <div className="nl-block-actions">
          <button type="button" className="nl-secondary" onClick={() => startEdit('fourExams')}>改一改</button>
          <button type="button" className="nl-primary" onClick={() => setCurrent(confirmHeardExams(current))}>就这样</button>
        </div>
      </>}
  </details>

  return <div className="nl-shell" data-long-record={longRecord ? 'yes' : 'no'}>
    <header className="nl-flow-head">
      <button type="button" className="nl-back" aria-label="返回" onClick={onBack}>‹</button>
      <div><h1>{alias} · 核对</h1><small>{subtitle ?? (examPending ? '下面是智能体的草稿' : '四诊已记好 · 下面是智能体的草稿')}</small></div>
    </header>
    <div className="nl-flow-body">
      {error && <p role="alert" className="nl-danger-strong">{error}</p>}
      {/* V2-19：减了旧病历或相似医案时说清楚，不悄悄少带。 */}
      {materialNote && materialNote.length > 0 && <p className="nl-quiet" role="note">这次的材料：{materialNote.join('；')}。</p>}
      {extras && <details className="nl-section"><summary>本次资料（舌象、扣费、方案）</summary>{extras}</details>}
      {longRecord && <div className="nl-fold-actions">
        <p className="nl-quiet">这份病历较长，已分段折叠。点每块标题展开。</p>
        <div className="nl-tabs">
          <button type="button" onClick={() => setOpenBlocks(Object.fromEntries(blocks.map(block => [block.key, true])))}>展开全部</button>
          <button type="button" onClick={() => setOpenBlocks(Object.fromEntries(blocks.map(block => [block.key, block.key === 'judgment'])))}>收起全部</button>
        </div>
      </div>}
      {examBlock}
      {blocks.map(block => longRecord
        ? <details key={block.key} className={'nl-review-block ' + (block.pending ? 'draft' : 'confirmed')} open={openBlocks[block.key] ?? block.key === 'judgment'}
          onToggle={event => { const open = event.currentTarget.open; setOpenBlocks(previous => ({ ...previous, [block.key]: open })) }}>
          <summary><h2>{block.title}</h2><span className={'nl-tag' + (block.pending ? ' draft' : '')}>{heroTag(block, Boolean(previousPrescription))}</span></summary>
          {blockBody(block)}
        </details>
        : <section key={block.key} className={'nl-review-block ' + (block.pending ? 'draft' : 'confirmed')} aria-label={block.title}>
          <div className="nl-block-head"><h2>{block.title}</h2><span className={'nl-tag' + (block.pending ? ' draft' : '')}>{heroTag(block, Boolean(previousPrescription))}</span></div>
          {blockBody(block)}
        </section>)}

      {onComparisonChange && <section className="nl-review-block confirmed" aria-label="和上次比">
        <div className="nl-block-head"><h2>和上次比</h2></div>
        <div className="nl-tabs" role="group" aria-label="和上次比">
          {OBSERVATION_CHOICES.map(choice => <button type="button" key={choice.value} aria-pressed={comparison === choice.value}
            onClick={() => onComparisonChange(comparison === choice.value ? null : choice.value)}>{choice.label}</button>)}
        </div>
        <p className="nl-quiet">不选也能签字，记为未评价（不是持平）。</p>
      </section>}

      {onRevise && <details className="nl-section">
        <summary>让智能体按一句话改草稿</summary>
        <label className="nl-quiet">说说怎么改<textarea rows={2} value={instruction} disabled={revising} placeholder="例如：去掉某味药、作业改成每晚泡脚" onChange={event => setInstruction(event.target.value)} /></label>
        <button type="button" disabled={revising || !instruction.trim()} onClick={() => void revise()}>按意见改稿</button>
      </details>}
    </div>
    <footer className="nl-review-foot">
      <p className={'nl-hint' + (pending > 0 ? '' : ' clear')}>{pending > 0 ? `还有 ${pending} 处草稿等您确认` : '都确认了，可以签字发出。'}</p>
      <button type="button" className="nl-primary" disabled={busy || pendingDraftCount(current) > 0} onClick={() => void sign()}>签字发出</button>
    </footer>
  </div>
}

function TextBody({ block }: { block: ReviewBlock }) {
  const shown = block.fields.filter(field => !field.missing)
  if (shown.length === 0) return <p className="nl-empty">还没有内容，点“改一改”手动填写。</p>
  return <>{shown.map(field => <div className="nl-review-field" key={field.path}>
    <small>{field.label}</small><p>{field.value}</p>
  </div>)}</>
}

function PrescriptionBody({ block, diffText }: { block: ReviewBlock; diffText: string }) {
  const value = block.prescription
  return <>
    {!value && <p className="nl-empty">还没有方子。点“改一改”手动填写，或让智能体起草。</p>}
    {value && <>
      <ul className="nl-herbs">{value.items.map(item => <li key={item.herb + item.dose}>{item.herb} {item.dose}</li>)}</ul>
      <p className="nl-quiet">{[value.method, value.days ? '服 ' + value.days + ' 天' : ''].filter(Boolean).join(' · ') || '剂量与煎服法由老师定'}</p>
      {value.changeReason && <p className="nl-quiet">加减理由：{value.changeReason}</p>}
      {diffText && <p className="nl-diff">{diffText}。</p>}
    </>}
  </>
}

function HomeworkBody({ items }: { items: Homework[] }) {
  if (items.length === 0) return <p className="nl-empty">还没有作业。</p>
  return <>{items.map(item => <div className="nl-homework-item" key={item.id}>
    <strong>{item.title}</strong>
    <p>{item.detail}</p>
    <p>{scheduleLabel(item.schedule)}{item.durationDays ? ' · ' + item.durationDays + ' 天' : ''}</p>
  </div>)}</>
}

function EditFields({ block, texts, setTexts, herbs, setHerbs, method, setMethod, days, setDays, reason, setReason,
  items, setItems, changeReasonNeeded, diffText, onSave, onCancel }: {
  block: ReviewBlock
  texts: Record<string, string>
  setTexts: (value: Record<string, string>) => void
  herbs: string
  setHerbs: (value: string) => void
  method: string
  setMethod: (value: string) => void
  days: string
  setDays: (value: string) => void
  reason: string
  setReason: (value: string) => void
  items: Homework[]
  setItems: (value: Homework[]) => void
  changeReasonNeeded: boolean
  diffText: string
  onSave: () => void
  onCancel: () => void
}) {
  const field = (path: string) => <label key={path}>{FIELD_LABELS[path] ?? path}<textarea rows={2} value={texts[path] ?? ''} onChange={event => setTexts({ ...texts, [path]: event.target.value })} /></label>
  return <div className="nl-edit">
    {block.key === 'judgment' && ['judgment.symptomSummary', 'judgment.pattern', 'judgment.mechanism', 'judgment.rationale', 'plan.principle'].map(field)}
    {block.key === 'advice' && field('plan.advice')}
    {block.key === 'prescription' && <>
      <label>药味（每行“药材 剂量”）<textarea rows={6} value={herbs} onChange={event => setHerbs(event.target.value)} /></label>
      <label>煎服法<input value={method} onChange={event => setMethod(event.target.value)} /></label>
      <label>服几天<input inputMode="numeric" value={days} onChange={event => setDays(event.target.value)} /></label>
      {changeReasonNeeded && <><p className="nl-diff">{diffText}。改了要写一句理由。</p>
        <label>改方理由<input value={reason} maxLength={200} onChange={event => setReason(event.target.value)} /></label></>}
    </>}
    {block.key === 'homework' && <>
      {items.map((item, index) => <div key={item.id} className="nl-homework-item">
        <label>作业标题<input value={item.title} onChange={event => setItems(items.map((row, i) => i === index ? { ...row, title: event.target.value } : row))} /></label>
        <label>说明<input value={item.detail} onChange={event => setItems(items.map((row, i) => i === index ? { ...row, detail: event.target.value } : row))} /></label>
        <button type="button" className="nl-secondary" onClick={() => setItems(items.filter((_, i) => i !== index))}>删掉这项</button>
      </div>)}
      <button type="button" className="nl-secondary" onClick={() => setItems([...items, { id: crypto.randomUUID(), title: '新作业', detail: '请填写说明', schedule: { kind: 'daily', time: '08:00' }, source: 'teacher' }])}>加一项作业</button>
    </>}
    <div className="nl-edit-actions">
      <button type="button" className="nl-secondary" onClick={onCancel}>先不改</button>
      <button type="button" className="nl-primary" onClick={onSave}>改成这样</button>
    </div>
  </div>
}
