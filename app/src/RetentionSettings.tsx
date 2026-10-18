import { useEffect, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { SendEnvelope } from './core/inbox'
import { teacherContactStudents } from './core/records/teacher'
import { requestStudentsRecords } from './core/records/backup'
import {
  RETENTION_DEFAULT_DAYS, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS,
  loadRetentionDays, publishRetentionDays, saveRetentionDays,
} from './core/records/retention'

// V2-05 第 1 步：记录保留多久，由老师在设置里定（默认 90 天，可选 30 天到 3 年）。
// 设置随调养方案一起发给学生；学生端按这个期限滚动删除自己的镜子记录、问诊卡片和作业打卡。
const CHOICES = [30, 60, 90, 180, 365, 730, RETENTION_MAX_DAYS]

export function RetentionSettings({ identity, store, send }: { identity: Identity; store: LocalStore; send?: SendEnvelope }) {
  const [days, setDays] = useState(RETENTION_DEFAULT_DAYS)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void loadRetentionDays(store).then(value => { if (active) setDays(value) }).catch(() => { if (active) setError('保留期限暂时无法读取。') })
    return () => { active = false }
  }, [store])

  const save = async (value: number) => {
    setError(''); setStatus('')
    try {
      if (!send) {
        await saveRetentionDays(store, value)
        setDays(value); setStatus('已保存；连上社区后会把新期限发给学生。')
        return
      }
      const count = await publishRetentionDays(store, identity.publicKey, value, send)
      setDays(value)
      setStatus(count === 0 ? '已保存。收到学生问诊后会通知他们。' : `已保存，并发给 ${count} 位学生。`)
    } catch { setError('保留期限未能保存，请稍后重试。') }
  }

  return <section aria-label="记录保留期限">
    <h2>记录保留期限</h2>
    <p>超过期限，双方的记录（镜子记录、问诊卡片、作业打卡、老师端医案）会按天滚动删除；调养方案、作业规则和老师的改稿习惯摘要长期保留。</p>
    <label>保留多久<select value={days} onChange={event => void save(Number(event.target.value))}>
      {CHOICES.map(value => <option key={value} value={value}>{value} 天</option>)}
    </select></label>
    <p className="inbox-note">可选 {RETENTION_MIN_DAYS} 天到 3 年（{RETENTION_MAX_DAYS} 天），默认 {RETENTION_DEFAULT_DAYS} 天。</p>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {send && <BackupNow identity={identity} store={store} send={send} />}
  </section>
}

// 老师换手机后可以主动再要一次：向认得的每位学生逐个请求自己签的病历（学生端自动回发）。
function BackupNow({ identity, store, send }: { identity: Identity; store: LocalStore; send: SendEnvelope }) {
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  return <div>
    <p className="inbox-note">换手机后，学生保存的病历可以要回来。</p>
    <button onClick={() => {
      setError(''); setStatus('')
      void (async () => {
        try {
          const students = await teacherContactStudents(store)
          if (students.length === 0) { setStatus('还没有认得的学生；收到问诊或医案后才能自动要回。'); return }
          await requestStudentsRecords(store, send)
          setStatus(`已向 ${students.length} 位学生发出请求，收到后会自动补回医案。`)
        } catch { setError('暂时未能发出请求，请稍后重试。') }
      })()
    }}>向学生要回我的病历</button>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    <p className="inbox-note">当前身份：{identity.publicKey.slice(0, 8)}…</p>
  </div>
}
