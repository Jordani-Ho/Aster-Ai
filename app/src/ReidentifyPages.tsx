import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import type { Identity } from './core/identity'
import { makeInvite } from './core/onboarding'
import {
  confirmStudentReidentify, confirmTeacherReidentify, listReidentifyRequests, matchCandidate,
  reidentifyLink, rejectStudentReidentify, sendStudentReidentifyRequest, teacherStudentCandidates,
  type PendingReidentifyRequest, type SendEnvelope, type StudentCandidate,
} from './core/reidentify'
import './inbox.css'

// V2-07：换手机靠师生互认找回身份。界面提示句按卡里的原话，是/不是两个按钮。
function shell(children: React.ReactNode) {
  return <main style={{ fontFamily: 'system-ui, sans-serif', padding: '24px 16px', maxWidth: 480, margin: '0 auto' }}>{children}</main>
}

/** 学生换手机：打开老师的找回链接 → 填称呼 → 发“我是原来的某某”。 */
export function StudentReidentifyRequestPage({ store, teacher, name, send, connected, onDone }: {
  store: LocalStore
  teacher: string
  name: string
  send?: SendEnvelope
  connected: boolean
  onDone: () => void
}) {
  const [alias, setAlias] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!send || busy || alias.trim() === '') return
    setBusy(true); setError('')
    try {
      await sendStudentReidentifyRequest(store, teacher, alias, send)
      setSent(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请求没有发出去，请连上社区后再试。')
    } finally { setBusy(false) }
  }
  const who = name ? name + '老师' : '老师'
  return shell(<>
    <h1>找回我的记录</h1>
    <p>这台手机是新的。已经连上{who}，填一下{who}平时怎么称呼你；确认后，保留期内的记录会自己回来。</p>
    {sent
      ? <><p role="status">{who}确认后，记录会自动回来。你可以先继续用。</p><button onClick={onDone}>先继续用</button></>
      : <>
        <label>老师怎么称呼你<input value={alias} maxLength={12} disabled={busy} onChange={event => setAlias(event.target.value)} placeholder="例如：小王" /></label>
        <p className="inbox-note">{connected ? '填好后发给老师，老师会当面或电话和你确认。' : '正在连接社区，连上后才能发送。'}</p>
        <button disabled={busy || !connected || alias.trim() === ''} onClick={() => void submit()}>发给老师确认</button>
        {error && <p role="alert">{error}</p>}
        <button onClick={onDone}>先不用了</button>
      </>}
  </>)
}

/** 老师换手机：学生打开老师的换机链接后，确认“是她吗？”；没点“是”之前不接受新公钥。 */
export function TeacherReidentifyPrompt({ store, newTeacher, name, oldTeachers, send, connected, onDone }: {
  store: LocalStore
  newTeacher: string
  name: string
  oldTeachers: string[]
  send?: SendEnvelope
  connected: boolean
  onDone: () => void
}) {
  const [oldTeacher, setOldTeacher] = useState(oldTeachers[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const who = name ? name + '老师' : '老师'
  const confirm = async () => {
    if (!send || !oldTeacher || busy) return
    setBusy(true); setError('')
    try {
      const events = (await store.list('student-records')).map(row => (row.value as { eventJson?: unknown }).eventJson).filter((value): value is string => typeof value === 'string')
      const result = await confirmTeacherReidentify({ store, oldTeacher, newTeacher, events, send })
      setDone(true)
      if (result.records === 0) setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没有认回成功，请连上社区后再试。')
    } finally { setBusy(false) }
  }
  if (oldTeachers.length === 0) {
    return shell(<>
      <h1>老师换手机</h1>
      <p>这台手机上还没有老师，暂时无法认回。请先用老师的邀请链接加入。</p>
      <button onClick={onDone}>返回</button>
    </>)
  }
  if (done) {
    return shell(<>
      <h1>已认回</h1>
      <p role="status">已经把{who}换成新手机上的身份，手里的记录会自动发过去。</p>
      <button onClick={onDone}>继续</button>
    </>)
  }
  return shell(<>
    <h1>{who}说她换了手机，是她吗？</h1>
    <p>只有你点了“是”，新手机上的{who}才被当作原来那位老师；点“不是”什么都不改、也不发。</p>
    {oldTeachers.length > 1 && <label>对应本机的哪位老师
      <select value={oldTeacher} disabled={busy} onChange={event => setOldTeacher(event.target.value)}>
        {oldTeachers.map(key => <option key={key} value={key}>{key.slice(0, 8)}…</option>)}
      </select>
    </label>}
    {error && <p role="alert">{error}</p>}
    <p className="inbox-note">{connected ? '' : '正在连接社区，连上后才能确认。'}</p>
    <button disabled={busy || !connected || !send} onClick={() => void confirm()}>是</button>
    <button disabled={busy} onClick={onDone}>不是</button>
  </>)
}

/** 老师端：待确认的“学生换手机”请求；称呼唯一匹配时预选旧学生，重名/没有匹配由老师自己选。 */
export function TeacherReidentifyInbox({ store, send }: { store: LocalStore; send?: SendEnvelope }) {
  const [requests, setRequests] = useState<PendingReidentifyRequest[]>([])
  const [candidates, setCandidates] = useState<StudentCandidate[]>([])
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const refresh = () => {
    void Promise.all([listReidentifyRequests(store), teacherStudentCandidates(store)]).then(([rows, list]) => {
      setRequests(rows); setCandidates(list)
      setChosen(previous => {
        const next: Record<string, string> = {}
        for (const request of rows) {
          next[request.student] = previous[request.student] ?? matchCandidate(list, request.alias)?.student ?? ''
        }
        return next
      })
    }).catch(() => setError('换机请求暂时无法读取。'))
  }
  useEffect(() => {
    let active = true
    refresh()
    const changed = () => { if (active) refresh() }
    window.addEventListener('aster:data-changed', changed)
    return () => { active = false; window.removeEventListener('aster:data-changed', changed) }
  }, [store])
  if (requests.length === 0 && !error) return null
  const decide = async (request: PendingReidentifyRequest, yes: boolean) => {
    if (!send) { setError('连上社区后才能确认换机请求。'); return }
    setBusy(request.student); setError(''); setStatus('')
    try {
      if (yes) {
        const oldStudent = chosen[request.student]
        if (!oldStudent) { setError('请先选择这孩子换机前是哪位学生。'); return }
        const result = await confirmStudentReidentify({ store, request, oldStudent, newStudent: request.student, send })
        setStatus(`已确认，已回发 ${result.records} 份保留期内的记录。`)
      } else {
        await rejectStudentReidentify({ store, request, send })
        setStatus('已作废，名单和记录都没有改动。')
      }
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作没有完成，请稍后重试。')
    } finally { setBusy('') }
  }
  return <section className="teacher-card" aria-label="换手机认回请求">
    <h2>换手机认回</h2>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {requests.map(request => <div key={request.student} className="inbox-note">
      <p>{request.alias}说他换了手机，是他吗？</p>
      <label>对应哪位学生
        <select value={chosen[request.student] ?? ''} disabled={busy === request.student} onChange={event => setChosen(previous => ({ ...previous, [request.student]: event.target.value }))}>
          <option value="">请选择</option>
          {candidates.map(candidate => <option key={candidate.student} value={candidate.student}>{(candidate.alias ?? '未填称呼') + ' · ' + candidate.student.slice(0, 8) + '…'}</option>)}
        </select>
      </label>
      <button disabled={busy === request.student || !chosen[request.student]} onClick={() => void decide(request, true)}>是</button>
      <button disabled={busy === request.student} onClick={() => void decide(request, false)}>不是</button>
    </div>)}
    <p className="inbox-note">点“是”后，旧学生公钥换成新公钥，并把保留期内的记录回发；点“不是”什么都不改、不发记录。</p>
  </section>
}

/** 老师端：生成两种换机找回链接（学生换手机 / 老师换手机）。 */
export function ReidentifyLinks({ identity, gateway }: { identity: Identity; gateway: string }) {
  const [name, setName] = useState('')
  const [studentLink, setStudentLink] = useState('')
  const [teacherLink, setTeacherLink] = useState('')
  const [message, setMessage] = useState('')
  const generate = (kind: 'student' | 'teacher') => {
    if (!gateway) { setMessage('还没有配置社区网关，暂时不能生成找回链接。'); return }
    try {
      const value = reidentifyLink(location.href, makeInvite(identity, gateway + '/invite/redeem'), kind, kind === 'teacher' ? name : undefined)
      if (kind === 'student') setStudentLink(value)
      else setTeacherLink(value)
      setMessage('此链接 7 天内有效；换手机的人打开后按提示操作。')
    } catch { setMessage('找回链接暂时无法生成，请稍后重试。') }
  }
  const copy = (value: string) => void navigator.clipboard?.writeText(value).then(() => setMessage('已复制，可以发给对方。')).catch(() => setMessage('请长按链接复制。'))
  return <section aria-label="换手机找回">
    <h2>换手机找回</h2>
    <p>不用抄任何东西，靠师生互认。学生换手机：发“学生换手机”链接给他；老师换手机：把“老师换手机”链接发给每位学生。</p>
    <label>你的称呼（学生提示里会显示“阿慈老师”）<input value={name} maxLength={12} onChange={event => setName(event.target.value)} placeholder="例如：阿慈" /></label>
    <div className="inbox-actions">
      <button disabled={!gateway} onClick={() => generate('student')}>生成“学生换手机”链接</button>
      <button disabled={!gateway || name.trim() === ''} onClick={() => generate('teacher')}>生成“老师换手机”链接</button>
    </div>
    {studentLink && <label>学生换手机链接<input readOnly value={studentLink} style={{ width: '100%' }} /><button onClick={() => copy(studentLink)}>复制</button></label>}
    {teacherLink && <label>老师换手机链接<input readOnly value={teacherLink} style={{ width: '100%' }} /><button onClick={() => copy(teacherLink)}>复制</button></label>}
    <p className="inbox-note">老师换手机：由老师本人把链接手动发给学生；学生点“是”后，手里的记录会自动发回新手机。</p>
    {!gateway && <p className="inbox-note">尚未配置社区网关（VITE_MODEL_GATEWAY_URL），找回链接需要它才可用。</p>}
    {message && <p role="status">{message}</p>}
    <p className="inbox-note">链接里的邀请 7 天有效：过期后重新生成一条即可。</p>
  </section>
}
