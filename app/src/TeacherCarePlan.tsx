import { useEffect, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { SendEnvelope } from './core/inbox'
import { knownStudents } from './core/record/in-person'
import { draftCarePlan } from './core/drafting/careplan'
import { issueCarePlan, pendingCarePlan, retryCarePlan, PlanUndeliveredError, type CarePlanDraft } from './core/careplan/issue'
import { loadRetentionDays, sendRetentionSetting } from './core/records/retention'

export function TeacherCarePlan({ identity, store, student, llm, send }: {
  identity: Identity; store: LocalStore; student: string; llm: LlmClient | null; send?: SendEnvelope
}) {
  const [instruction, setInstruction] = useState('')
  const [draft, setDraft] = useState<CarePlanDraft | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    void pendingCarePlan(store, identity, student).then(saved => {
      if (!active || !saved) return
      setDraft({ constitution: saved.plan.constitution, points: saved.plan.points, avoid: saved.plan.avoid, source: 'ai_draft' })
      setPending(saved.key); setNotice('上次尚未发出，可以重发。')
    }).catch(() => { if (active) setNotice('待发方案读取失败，请稍后重试。') })
    return () => { active = false }
  }, [store, identity, student])
  return <div className="careplan-editor">
    <form onSubmit={event => {
      event.preventDefault()
      if (!llm || busy || pending) return
      setBusy(true); setNotice('')
      void draftCarePlan(instruction, llm).then(setDraft).catch(() => setNotice('方案起草未完成，请重试。')).finally(() => setBusy(false))
    }}>
      <label>调养要点<textarea rows={2} maxLength={2000} value={instruction} disabled={busy || !!pending} onChange={e => setInstruction(e.target.value)} placeholder="用键盘话筒说体质、日常调养和需要避开的事" /></label>
      <button disabled={!llm || busy || !!pending || !instruction.trim()}>整理方案</button>
      {!llm && <p>暂未连接起草助手，请稍后重试。</p>}
    </form>
    {draft && <article aria-label="调养方案卡片" className="teacher-card">
      <strong>{pending ? '已签字待发' : 'AI 草稿'}</strong>
      <p>体质：{draft.constitution}</p>
      <ul>{draft.points.map((point, i) => <li key={i}>{point}</li>)}</ul>
      {draft.avoid.length > 0 && <p>注意避开：{draft.avoid.join('、')}</p>}
      <button disabled={busy} onClick={async () => {
        setBusy(true); setNotice('')
        try {
          const issued = pending
            ? await retryCarePlan({ identity, store, pendingKey: pending, send })
            : await issueCarePlan({ identity, store, student, draft, send })
          // V2-17：老师端留一份刚签发的方案，供“一位学生”页显示当前方案（只存本机，不进协议）。
          try { await store.put('care-plan-snapshot', student, issued as unknown as import('./core/store').StoreValue) } catch { /* 快照失败不影响方案已签发 */ }
          // V2-05：保留期限随调养方案一起发给这位学生（学生端据此滚动删除自己的记录）。
          if (send && student !== identity.publicKey) {
            try { await sendRetentionSetting(send, identity.publicKey, await loadRetentionDays(store), [student]) } catch { /* 方案已发出，设置晚点再随下一次方案补发。 */ }
          }
          setPending(null); setDraft(null); setInstruction('')
          setNotice(student === identity.publicKey ? '给自己的方案已确认，明天的建议会参考它。' : '调养方案已签发，学生明天的建议会参考它。')
          window.dispatchEvent(new Event('aster:data-changed'))
        } catch (cause) {
          if (cause instanceof PlanUndeliveredError) setPending(cause.pendingKey)
          setNotice('方案未发出，资料已保留，可重发。')
        } finally { setBusy(false) }
      }}>{pending ? '重发方案' : '确认并签发方案'}</button>
    </article>}
    {notice && <p role="status">{notice}</p>}
  </div>
}

export function CarePlanStudentPicker({ store, render }: { store: LocalStore; render: (student: string) => import('react').ReactNode }) {
  const [students, setStudents] = useState<string[]>([]), [student, setStudent] = useState('')
  useEffect(() => {
    let active = true
    const refresh = () => void knownStudents(store).then(rows => { if (active) { setStudents(rows); setStudent(old => rows.includes(old) ? old : rows[0] ?? '') } }).catch(() => {})
    refresh(); window.addEventListener('aster:data-changed', refresh)
    return () => { active = false; window.removeEventListener('aster:data-changed', refresh) }
  }, [store])
  return <details className="inbox-card"><summary>定制调养方案</summary>
    {students.length === 0 ? <p>收到学生问诊后，即可为学生定制。</p> : <>
      {students.length > 1 && <label>选择方案学生<select value={student} onChange={e => setStudent(e.target.value)}>{students.map((person, i) => <option key={person} value={person}>学生 {i + 1}</option>)}</select></label>}
      {student && render(student)}
    </>}
  </details>
}
