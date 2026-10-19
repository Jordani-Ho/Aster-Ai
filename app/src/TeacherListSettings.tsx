import { useEffect, useState } from 'react'
import { loadTeachers, removeTeacher } from './core/inbox'
import { loadTeacherLabels, saveTeacherLabel, teacherLabel, type TeacherLabels } from './core/identity/teacher-labels'
import type { LocalStore } from './core/store'

// V2-07：学生可以给老师记一个称呼/馆名；换机提示与列表里优先显示它，没有就显示“老师 + 公钥后 6 位”。
export function TeacherListSettings({ store }: { store: LocalStore }) {
  const [teachers, setTeachers] = useState<string[]>([])
  const [labels, setLabels] = useState<TeacherLabels>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  useEffect(() => {
    void loadTeachers(store).then(setTeachers).catch(() => setError('老师名单暂时无法读取。'))
    void loadTeacherLabels(store).then(setLabels).catch(() => {})
  }, [store])
  const save = (teacher: string) => {
    void saveTeacherLabel(store, teacher, drafts[teacher] ?? '').then(next => { setLabels(next); setError('') }).catch(() => setError('称呼需要 1 至 20 个字，未能保存。'))
  }
  return <section aria-label="我的老师"><h3>我的老师</h3><p>打开老师的邀请链接即可加入，病历只接收已登记老师的签字版本。给老师填个称呼，换手机认回时能看清选的是谁。</p>{!teachers.length&&<p>请向老师要一个邀请链接。</p>}<ul>{teachers.map(teacher=><li key={teacher}>
    <strong>{teacherLabel(labels, teacher)}</strong>
    <label>称呼<input value={drafts[teacher] ?? labels[teacher] ?? ''} maxLength={20} placeholder="例如：阿慈" onChange={event => setDrafts(previous => ({ ...previous, [teacher]: event.target.value }))} onBlur={() => save(teacher)} /></label>
    <button onClick={() => void removeTeacher(store, teacher).then(setTeachers).catch(() => setError('暂时未能移除。'))}>移除</button>
  </li>)}</ul>{error&&<p role="alert">{error}</p>}</section>
}
