import { useState } from 'react'
import type { Encounter, Field, Homework, Source } from './core/record/types'
import { pendingDraftFields } from './core/record/sign'
import './sign-encounter.css'

const SOURCE_LABELS: Record<Source, string> = {
  student: '学生陈述',
  teacher: '老师判断',
  ai_draft: 'AI 草稿',
  external: '外部证据',
  unknown: '未知',
}

const FOUR_EXAMS: [keyof Encounter['fourExams'], string][] = [
  ['look', '望'], ['listenSmell', '闻'], ['ask', '问'], ['pulse', '切'],
]
const JUDGMENT: [keyof Encounter['judgment'], string][] = [
  ['symptomSummary', '症状摘要'], ['pattern', '证候'], ['mechanism', '病机'], ['rationale', '辨证依据'],
]

interface Descriptor {
  path: string
  label: string
  source: Source
  value: unknown
}

function descriptors(encounter: Encounter): Descriptor[] {
  const list: Descriptor[] = []
  for (const [key, label] of FOUR_EXAMS) {
    list.push({ path: 'fourExams.' + key, label: '四诊 · ' + label, source: encounter.fourExams[key].source, value: encounter.fourExams[key].value })
  }
  for (const [key, label] of JUDGMENT) {
    list.push({ path: 'judgment.' + key, label: '判断 · ' + label, source: encounter.judgment[key].source, value: encounter.judgment[key].value })
  }
  list.push({ path: 'plan.principle', label: '处理 · 治则治法', source: encounter.plan.principle.source, value: encounter.plan.principle.value })
  list.push({ path: 'plan.prescription', label: '处理 · 方子', source: encounter.plan.prescription.source, value: encounter.plan.prescription.value })
  list.push({ path: 'plan.advice', label: '处理 · 医嘱', source: encounter.plan.advice.source, value: encounter.plan.advice.value })
  encounter.plan.homework.forEach((item, index) => {
    list.push({ path: 'plan.homework[' + index + ']', label: '作业 · ' + item.title, source: item.source, value: item })
  })
  return list
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '未知'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function withField(encounter: Encounter, path: string, update: (field: Field<unknown>) => Field<unknown>): Encounter {
  const [section, key] = path.split('.') as ['fourExams' | 'judgment', keyof Encounter['fourExams'] & keyof Encounter['judgment']]
  return { ...encounter, [section]: { ...encounter[section], [key]: update(encounter[section][key]) } }
}

function withPlanField(encounter: Encounter, key: 'principle' | 'prescription' | 'advice', update: (field: Field<unknown>) => Field<unknown>): Encounter {
  return { ...encounter, plan: { ...encounter.plan, [key]: update(encounter.plan[key]) } }
}

function accept(encounter: Encounter, descriptor: Descriptor): Encounter {
  if (descriptor.path.startsWith('plan.homework[')) {
    const index = Number(descriptor.path.slice('plan.homework['.length, -1))
    const homework = encounter.plan.homework.map((item, position): Homework => position === index
      ? { ...item, source: 'teacher', note: 'ai_accepted' }
      : item)
    return { ...encounter, plan: { ...encounter.plan, homework } }
  }
  const mark = (field: Field<unknown>): Field<unknown> => ({ ...field, source: 'teacher', note: 'ai_accepted' })
  if (descriptor.path.startsWith('plan.')) return withPlanField(encounter, descriptor.path.slice('plan.'.length) as 'principle' | 'prescription' | 'advice', mark)
  return withField(encounter, descriptor.path, mark)
}

function modify(encounter: Encounter, descriptor: Descriptor, value: unknown): Encounter {
  if (descriptor.path.startsWith('plan.homework[')) {
    const index = Number(descriptor.path.slice('plan.homework['.length, -1))
    const homework = encounter.plan.homework.map((item, position): Homework => position === index
      ? { ...(value as Homework), source: 'teacher' }
      : item)
    return { ...encounter, plan: { ...encounter.plan, homework } }
  }
  const replace = (_field: Field<unknown>): Field<unknown> => ({ value, source: 'teacher' })
  if (descriptor.path.startsWith('plan.')) return withPlanField(encounter, descriptor.path.slice('plan.'.length) as 'principle' | 'prescription' | 'advice', replace)
  return withField(encounter, descriptor.path, replace)
}

export interface SignEncounterPageProps {
  initial: Encounter
  onConfirm: (encounter: Encounter) => Promise<void> | void
  onCancel?: () => void
}

// 老师端审改界面：来源用颜色区分；AI 草稿逐项“采用”或“修改”；全部确认后才能签字。
export function SignEncounterPage({ initial, onConfirm, onCancel }: SignEncounterPageProps) {
  const [encounter, setEncounter] = useState(initial)
  const [editing, setEditing] = useState<{ path: string; text: string; original: unknown } | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = pendingDraftFields(encounter)
  const beginEdit = (descriptor: Descriptor) => {
    setEditing({
      path: descriptor.path,
      text: typeof descriptor.value === 'string' ? descriptor.value : JSON.stringify(descriptor.value, null, 2),
      original: descriptor.value,
    })
  }
  const saveEdit = () => {
    if (!editing) return
    const descriptor = descriptors(encounter).find(item => item.path === editing.path)
    if (!descriptor) return
    const value = typeof editing.original === 'string' ? editing.text : JSON.parse(editing.text)
    setEncounter(modify(encounter, descriptor, value))
    setEditing(null)
  }
  return (
    <main className="sign-page">
      <header className="sign-head">
        <h1>审改并签字</h1>
        <p className="sign-meta">第 {encounter.version} 版 · {encounter.id.slice(0, 8)} · 病历里的老师：已核验身份</p>
        <ul className="sign-legend" aria-label="来源颜色说明">
          {(Object.keys(SOURCE_LABELS) as Source[]).map(source => (
            <li key={source}><span className={'source source-' + source}>{SOURCE_LABELS[source]}</span></li>
          ))}
        </ul>
      </header>
      <section>
        {descriptors(encounter).map(descriptor => (
          <article className="sign-field" key={descriptor.path}>
            <div className="sign-field-head">
              <h2>{descriptor.label}</h2>
              <span className={'source source-' + descriptor.source}>{SOURCE_LABELS[descriptor.source]}</span>
            </div>
            <p className="sign-value">{display(descriptor.value)}</p>
            {descriptor.source === 'ai_draft' && (
              <div className="sign-actions">
                <button type="button" onClick={() => setEncounter(accept(encounter, descriptor))}>采用</button>
                <button type="button" onClick={() => beginEdit(descriptor)}>修改</button>
              </div>
            )}
          </article>
        ))}
      </section>
      {editing && (
        <section className="sign-editor">
          <h2>修改内容</h2>
          <textarea rows={5} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} />
          <div className="sign-actions">
            <button type="button" onClick={saveEdit}>保存修改</button>
            <button type="button" onClick={() => setEditing(null)}>取消</button>
          </div>
        </section>
      )}
      <footer className="sign-foot">
        <p role="status">{pending.length === 0 ? '所有 AI 草稿均已确认，可以签字。' : '还有 ' + pending.length + ' 项 AI 草稿未确认：' + pending.join('、')}</p>
        <div className="sign-actions">
          <button type="button" className="sign-primary" disabled={pending.length > 0 || busy} onClick={async () => {
            setBusy(true)
            try { await onConfirm(encounter) } finally { setBusy(false) }
          }}>确认无误，签字</button>
          {onCancel && <button type="button" onClick={onCancel}>返回</button>}
        </div>
      </footer>
    </main>
  )
}
