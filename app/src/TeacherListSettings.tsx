import { useEffect, useState } from 'react'
import { addTeacher, loadTeachers, removeTeacher } from './core/inbox'
import type { LocalStore } from './core/store'

function message(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '操作失败，请重试'
}

// 学生端“我的老师”白名单：只接受名单里的老师签发的病历；登记后旧数据也会重新显示。
export function TeacherListSettings({ store }: { store: LocalStore }) {
  const [teachers, setTeachers] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadTeachers(store).then(rows => { if (!cancelled) setTeachers(rows) })
      .catch(() => { if (!cancelled) setError('老师名单读取失败，请稍后重试。') })
    return () => { cancelled = true }
  }, [store])

  const add = async () => {
    setBusy(true); setError(''); setStatus('')
    try {
      const value = input.trim().toLowerCase()
      setTeachers(await addTeacher(store, value))
      setInput('')
      setStatus('已加入“我的老师”。')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  const remove = async (teacher: string) => {
    setBusy(true); setError(''); setStatus('')
    try {
      setTeachers(await removeTeacher(store, teacher))
      setStatus('已移除。移除后这位老师的病历就不再显示。')
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }

  return <section aria-label="我的老师">
    <h3>我的老师</h3>
    <p>学生端只显示名单里这些老师签发的病历。发出问诊包后，收件老师会自动加入。</p>
    <label>老师公钥（64 位十六进制）<input value={input} onChange={event => setInput(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} style={{ width: '100%', boxSizing: 'border-box' }} /></label>
    <p><button type="button" disabled={busy || !input.trim()} onClick={() => void add()}>添加老师</button></p>
    {teachers.length === 0 && <p>还没有登记老师。</p>}
    {teachers.length > 0 && <ul>
      {teachers.map(teacher => <li key={teacher} style={{ overflowWrap: 'anywhere' }}>
        {teacher}{' '}<button type="button" disabled={busy} onClick={() => void remove(teacher)}>移除</button>
      </li>)}
    </ul>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
