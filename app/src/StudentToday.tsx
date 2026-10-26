import { useEffect, useRef, useState } from 'react'
import type { LocalStore } from './core/store'
import type { Identity } from './core/identity'
import type { LlmClient } from './core/llm'
import type { FamilyMember } from './core/family'
import type { TongueAbstract } from '../../domain/tcm/tongue'
import { tongueColorNote, tongueFeatureShortText } from '../../domain/tcm/tongue'
import { currentCarePlan, type CarePlan } from './core/careplan'
import { loadProfile } from './core/intake/session'
import { adherenceReport } from './core/adherence'
import { checkIn, listCheckins, type Assignment, type Checkin } from './core/homework'
import { schedule, effectiveDay, localDay } from './core/homework/schedule'
import { formatHeavenTime, heavenNow, heavenStampOf, type HeavenTime } from './core/heaven'
import { listTongueDays, loadTongue, latestTongueCrop, saveTongue } from './core/tongue'
import { seasonalTexts } from '../../domain/tcm/seasonal'
import { loadTeachers } from './core/inbox'
import { listIdentityLinks, oldKeysFor } from './core/identity/links'
import { MemberSwitcher } from './MemberSwitcher'
import { cancelOwnAppointment, listAppointments, replyToAppointment, requestAppointment, type Appointment } from './core/appointments'
import { isSameCity } from './core/city'
import type { SendEnvelope } from './core/inbox'
import { formatAppointmentTime } from './core/schedule/appointments'
import { TongueCapture } from './TongueCapture'
import { DailyMirrorCard } from './DailyMirrorCard'
import './newui.css'

// V2-16 学生·首页（04）：天时卡 / 照镜子 / 今日作业 / 不舒服告诉老师。
// 四块一屏内看得到，作业多时作业区内部滚动；打卡圆圈点一下变对勾。
export interface StudentTodayProps {
  store: LocalStore
  modelStore: LocalStore
  settingsStore: LocalStore
  identity: Identity
  llm: LlmClient | null
  teacher: string | null
  teacherCall: string
  teacherName: string
  teacherCity: string | null
  member?: Pick<FamilyMember, 'account' | 'alias'> | null
  family?: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active?: number
  onSwitch?: (account: number) => void
  onConsult: () => void
  onHomework: () => void
  onCheckedIn: () => void
  sendEnvelope?: SendEnvelope
}

interface TodayRow { homeworkId: string; title: string; note: string; done: boolean }

function greeting(now: Date): string {
  const hour = now.getHours()
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function StudentToday({
  store, modelStore, settingsStore, identity, llm, teacher, teacherCall, teacherName, teacherCity,
  member, family = [], active = 0, onSwitch, onConsult, onHomework, onCheckedIn, sendEnvelope,
}: StudentTodayProps) {
  const [now, setNow] = useState(() => new Date())
  const [heaven, setHeaven] = useState<HeavenTime | null>(null)
  const [plan, setPlan] = useState<CarePlan | null>(null)
  const [alias, setAlias] = useState('')
  const [studentCity, setStudentCity] = useState<string | null>(null)
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [record, setRecord] = useState<TongueAbstract | null>(null)
  const [recordLabel, setRecordLabel] = useState('上次')
  const [cropUrl, setCropUrl] = useState('')
  const [status, setStatus] = useState('')
  // V2-28：舌象保存提示只出现在“照镜子”卡里；打卡提示仍留在“今日作业”。
  const [mirrorStatus, setMirrorStatus] = useState('')
  const [error, setError] = useState('')
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [appointmentNote, setAppointmentNote] = useState('')
  const [appointmentBusy, setAppointmentBusy] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [requestSlots, setRequestSlots] = useState([''])
  const [cityPromptDismissed, setCityPromptDismissed] = useState('')
  const [cityPromptBusy, setCityPromptBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  // 刚拍完的舌象不能被“读本机旧记录”的异步结果覆盖（CI 上两者会抢）。
  const captured = useRef(false)

  const calendarToday = localDay(now)
  const today = effectiveDay(now)
  const stamp = heaven ? heavenStampOf(heaven) : undefined

  // 天时每分钟刷新；打卡用 effectiveDay，舌象按自然日存档。
  useEffect(() => {
    let cancelled = false
    const tick = () => setNow(new Date())
    const timer = setInterval(() => { tick(); void heavenNow(store).then(time => { if (!cancelled) setHeaven(time) }).catch(() => {}) }, 60_000)
    tick()
    void heavenNow(store).then(time => { if (!cancelled) setHeaven(time) }).catch(() => {})
    window.addEventListener('focus', tick)
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [store])

  // 老师方案（没方案时用通用节气建议，并注明不是老师给的）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const teachers = teacher ? [teacher] : await loadTeachers(store)
        let value: CarePlan | null = null
        if (teachers[0]) {
          const links = await listIdentityLinks(store)
          for (const candidate of teachers) {
            value = await currentCarePlan(store, candidate)
            if (value) break
            for (const old of oldKeysFor(links, 'teacher', candidate)) { value = await currentCarePlan(store, old); if (value) break }
            if (value) break
          }
        }
        if (!cancelled) setPlan(value)
      } catch { /* 读不到方案不进统计，也不拦页面 */ }
    })()
    return () => { cancelled = true }
  }, [store, teacher])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const profile = await loadProfile(store)
        if (!cancelled) setAlias(member?.alias ?? profile.alias.value ?? '')
      } catch { /* 称呼读不到就用默认 */ }
      try {
        const [rows, records, days, latestCrop] = await Promise.all([store.list('homework'), listCheckins(store), listTongueDays(store), latestTongueCrop(store)])
        if (cancelled) return
        setAssignments(rows.map(row => row.value as unknown as Assignment))
        setCheckins(records)
        const todayKey = localDay(new Date())
        let current: TongueAbstract | null = null
        let label = '上次'
        if (days.includes(todayKey)) { current = await loadTongue(store, todayKey); label = '今天' }
        else {
          const prior = days.filter(day => day < todayKey).sort().at(-1)
          if (prior) { current = await loadTongue(store, prior); label = prior === localDay(new Date(Date.now() - 86400000)) ? '昨天' : prior.slice(5) }
        }
        if (cancelled) return
        if (captured.current) return
        setRecord(current); setRecordLabel(label)
        if (current?.crop && latestCrop && latestCrop.id === current.crop.id) {
          const blob = new Blob([latestCrop.data.slice().buffer as ArrayBuffer], { type: 'image/jpeg' })
          setCropUrl(previous => { if (previous) URL.revokeObjectURL(previous); return URL.createObjectURL(blob) })
        }
      } catch { if (!cancelled) setError('本机作业或舌象读取失败，请稍后重试。') }
    })()
    return () => { cancelled = true }
  }, [store, member])

  useEffect(() => {
    let cancelled = false
    const refreshCity = () => { void loadProfile(store).then(profile => { if (!cancelled) setStudentCity(profile.city.value ?? null) }).catch(() => {}) }
    refreshCity()
    window.addEventListener('focus', refreshCity); window.addEventListener('aster:data-changed', refreshCity)
    return () => { cancelled = true; window.removeEventListener('focus', refreshCity); window.removeEventListener('aster:data-changed', refreshCity) }
  }, [store, member])

  useEffect(() => () => { if (cropUrl) URL.revokeObjectURL(cropUrl) }, [cropUrl])

  useEffect(() => {
    let cancelled = false
    const refresh = () => { void listAppointments(store).then(rows => { if (!cancelled) setAppointments(rows) }).catch(() => {}) }
    refresh()
    const timer = setInterval(() => { refresh(); setNow(new Date()) }, 15_000)
    window.addEventListener('aster:data-changed', refresh); window.addEventListener('focus', refresh)
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('aster:data-changed', refresh); window.removeEventListener('focus', refresh) }
  }, [store])

  const rows: TodayRow[] = []
  for (const item of assignments) {
    let scheduled
    try { scheduled = schedule([item.homework], item.startsOn, 1, today) } catch { continue }
    const at = scheduled.find(entry => entry.homeworkId === item.homework.id)
    if (!at) continue
    const done = checkins.some(recordRow => recordRow.homeworkId === item.homework.id && localDay(new Date(recordRow.at)) === calendarToday)
    rows.push({ homeworkId: item.homework.id, title: item.homework.title, note: item.homework.schedule.kind === 'habit' ? '随习惯：' + item.homework.schedule.anchor : at.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), done })
  }
  for (const item of assignments) {
    if (item.homework.schedule.kind !== 'habit' || rows.some(row => row.homeworkId === item.homework.id)) continue
    const done = checkins.some(recordRow => recordRow.homeworkId === item.homework.id && localDay(new Date(recordRow.at)) === calendarToday)
    rows.push({ homeworkId: item.homework.id, title: item.homework.title, note: '随习惯：' + item.homework.schedule.anchor, done })
  }
  const report = adherenceReport(assignments, checkins, today)
  const seasonal = heaven ? seasonalTexts(heaven.jieqi) : null
  const planLine = plan ? (plan.points[0] ?? plan.constitution) : seasonal ? `${seasonal.living} ${seasonal.diet}` : ''
  const greetingName = alias.trim() === '' ? '' : '，' + alias.trim()
  const planSource = plan ? `来自${teacherCall || teacherName || '老师'}给您的方案` : '没有老师给的方案，这是通用的节气建议'
  const ownAppointments = appointments.filter(row => row.student === identity.publicKey && (!teacher || row.teacher === teacher)
    && (['offered', 'accepted', 'confirmed', 'requested'].includes(row.status)
      ? (row.status === 'offered' ? row.expiresAt > +now : Date.parse(row.slotStart) > +now)
      : row.status === 'cancelled' && +now - Date.parse(row.createdAt) < 14 * 86_400_000))
  const hasFutureAppointment = ownAppointments.some(row => ['offered', 'requested', 'accepted', 'confirmed'].includes(row.status) && Date.parse(row.slotStart) > +now)
  const sameCity = isSameCity(studentCity, teacherCity)
  const cityChangedBooking = ownAppointments.find(row => row.status === 'confirmed' && Date.parse(row.slotStart) > +now
    && !isSameCity(studentCity, teacherCity ?? row.teacherCity))
  const cityPromptKey = cityChangedBooking ? `${cityChangedBooking.offerId}:${studentCity ?? ''}` : ''

  const submitAppointmentRequest = async () => {
    if (!teacher || !sendEnvelope || appointmentBusy) return
    const selected = requestSlots.filter(Boolean).map(value => new Date(value).getTime())
    setAppointmentBusy(true); setError('')
    try {
      await requestAppointment({ store, identity, teacher, startsAt: selected,
        settingsStore, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', send: sendEnvelope })
      setAppointments(await listAppointments(store))
      setRequestOpen(false); setRequestSlots([''])
      setAppointmentNote('预约请求已发给老师，确认后会在这里显示。')
      window.dispatchEvent(new Event('aster:data-changed'))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '预约请求没有发出，请重试。') }
    finally { setAppointmentBusy(false) }
  }

  const toggleCheck = async (homeworkId: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await checkIn(store, homeworkId, undefined, new Date(), stamp)
      setCheckins(await listCheckins(store))
      setNow(new Date())
      setStatus('已记在这台手机上')
      onCheckedIn()
      window.dispatchEvent(new Event('aster:data-changed'))
    } catch { setError('打卡没能保存，请重试。') } finally { setBusy(false) }
  }

  return <div className="nl-page" data-page="student-today">
    <div className="nl-top"><small>{[teacherName, teacherCall].filter(Boolean).join(' · ') || '知衡'}</small><small /></div>
    <h1>{greeting(now)}{greetingName}</h1>

    {family.length > 0 && <MemberSwitcher members={family} active={active} onChange={account => onSwitch?.(account)} />}

    <section className="nl-student-hero" aria-label="天时与今日调养">
      <p className="nl-jieqi">{heaven ? [formatHeavenTime(heaven), heaven.jieqi].filter(Boolean).join(' · ') : '正在算天时…'}</p>
      <h2>{planLine || '今天先照照镜子，做一件安排好的事。'}</h2>
      <p>{planSource}</p>
    </section>

    <section className="nl-card" aria-label="老师邀约">
      <div className="nl-top"><h2>老师邀约</h2><span className="nl-meta">{ownAppointments.length} 条</span></div>
      {ownAppointments.length === 0 && <p className="nl-empty">老师有合适的面诊时间时，会在这里邀请您。</p>}
      {ownAppointments.map(item => <div className="nl-appointment" key={item.offerId}>
        <strong>{item.status === 'confirmed' ? '已确认面诊' : item.status === 'accepted' ? '已回复，等老师确认' : item.status === 'requested' ? '预约请求已发出' : item.status === 'cancelled' ? '预约有变动' : '老师请您来面诊'}</strong>
        <p>{item.status === 'requested' || (item.status === 'cancelled' && ['slot_full', 'unavailable'].includes(item.reason ?? '')) ? '您选的时间：' + formatAppointmentTime(item.slotStart, item.timezone) : formatAppointmentTime(item.slotStart, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', item.teacherCity, item.timezone)} · {item.minutes} 分钟</p>
        {item.status === 'requested' && <p className="nl-quiet">等老师按排班确认一个时间。</p>}
        {item.status === 'cancelled' && <p className="nl-quiet">{item.reason === 'slot_full' ? '老师选的时段约满了，请换几个时间再试。' : item.reason === 'schedule_changed' ? '老师调整了排班，这次预约已取消。' : item.reason === 'already_booked' ? '您已有待回复邀约、预约请求或未来预约。' : item.reason === 'different_city' ? '你现在不在老师所在城市，请从远程问诊联系老师。' : '老师暂时无法确认这些时间，可以重新预约。'}</p>}
        {item.status === 'offered' && <>
          <p className="nl-quiet">还剩 {Math.max(0, Math.ceil((item.expiresAt - +now) / 60_000))} 分钟回复</p>
          <div className="nl-actions">
            <button type="button" className="nl-primary" disabled={appointmentBusy || !sendEnvelope} onClick={() => {
              if (!sendEnvelope) return
              setAppointmentBusy(true)
              void replyToAppointment({ store, identity, offerId: item.offerId, response: 'accept', send: sendEnvelope }).then(() => listAppointments(store).then(setAppointments)).then(() => window.dispatchEvent(new Event('aster:data-changed'))).catch(cause => setError(cause instanceof Error ? cause.message : '回复没有发出，请重试。')).finally(() => setAppointmentBusy(false))
            }}>接受</button>
            <button type="button" className="nl-link-button" disabled={appointmentBusy || !sendEnvelope} onClick={() => {
              if (!sendEnvelope) return
              setAppointmentBusy(true)
              void replyToAppointment({ store, identity, offerId: item.offerId, response: 'decline', send: sendEnvelope }).then(() => listAppointments(store).then(setAppointments)).then(() => window.dispatchEvent(new Event('aster:data-changed'))).catch(cause => setError(cause instanceof Error ? cause.message : '回复没有发出，请重试。')).finally(() => setAppointmentBusy(false))
            }}>这次不约</button>
          </div>
        </>}
        {item.status === 'accepted' && <p className="nl-quiet">老师正在确认时段容量。</p>}
      </div>)}
      {cityChangedBooking && cityPromptDismissed !== cityPromptKey && <div className="nl-card" role="alertdialog" aria-label="确认是否保留面诊">
        <p>你现在不在老师所在城市，这次面诊要保留吗？</p>
        <div className="nl-actions">
          <button type="button" className="nl-primary" disabled={cityPromptBusy} onClick={() => {
            if (!sendEnvelope) return
            setCityPromptBusy(true)
            void cancelOwnAppointment(store, identity, cityChangedBooking.offerId, new Date(), sendEnvelope)
              .then(() => listAppointments(store).then(setAppointments))
              .then(() => { setCityPromptDismissed(cityPromptKey); setAppointmentNote('已取消面诊，并通知老师。'); window.dispatchEvent(new Event('aster:data-changed')) })
              .catch(cause => setError(cause instanceof Error ? cause.message : '取消没有发出，请重试。'))
              .finally(() => setCityPromptBusy(false))
          }}>取消并通知老师</button>
          <button type="button" className="nl-link-button" disabled={cityPromptBusy} onClick={() => setCityPromptDismissed(cityPromptKey)}>保留</button>
        </div>
      </div>}
      {teacher && sameCity && <>
        {!requestOpen && <button type="button" className="nl-link-button" disabled={!sendEnvelope || hasFutureAppointment} onClick={() => setRequestOpen(true)}>{hasFutureAppointment ? '已有待回复邀约、预约请求或未来预约' : '想预约？选几个方便的时间'}</button>}
        {requestOpen && <div className="nl-request-slots">
          <p className="nl-quiet">最多选三个时间，老师会按排班自动确认其中一个。请选择两小时后、60 天内的整分时间。</p>
          {requestSlots.map((value, index) => <label key={index}>时间 {index + 1}
            <input type="datetime-local" step="60" value={value} min={new Date(Date.now() + 2 * 60 * 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)}
              max={new Date(Date.now() + 60 * 86_400_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)}
              onChange={event => setRequestSlots(current => current.map((slot, slotIndex) => slotIndex === index ? event.target.value : slot))} />
            {requestSlots.length > 1 && <button type="button" className="nl-link-button" onClick={() => setRequestSlots(current => current.filter((_, slotIndex) => slotIndex !== index))}>移除</button>}
          </label>)}
          {requestSlots.length < 3 && <button type="button" className="nl-link-button" onClick={() => setRequestSlots(current => [...current, ''])}>再加一个时间</button>}
          <div className="nl-actions"><button type="button" className="nl-primary" disabled={appointmentBusy || !sendEnvelope || requestSlots.some(value => !value)} onClick={() => void submitAppointmentRequest()}>发给老师</button>
            <button type="button" className="nl-link-button" disabled={appointmentBusy} onClick={() => { setRequestOpen(false); setRequestSlots(['']) }}>先不约</button></div>
        </div>}
      </>}
      {teacher && !sameCity && <button type="button" className="nl-link-button" onClick={onConsult}>远程问诊</button>}
      {appointmentNote && <p role="status" className="nl-quiet">{appointmentNote}</p>}
      {error && <p role="alert" className="nl-danger-strong">{error}</p>}
    </section>

    <section className="nl-card" aria-label="照镜子">
      <div className="nl-top"><h2>照镜子</h2><span className="nl-meta">{record ? `${recordLabel}：舌${tongueFeatureShortText(record.features, 'color')} · 苔${tongueFeatureShortText(record.features, 'coatingColor')}` : '还没有拍过舌象'}</span></div>
      <div className="nl-mirror-frames">
        <div className="nl-mirror-frame">
          {cropUrl ? <img src={cropUrl} alt="舌头裁剪图" /> : record ? <span>裁剪图已不在本机</span> : <span>{recordLabel}的舌头</span>}
        </div>
        <div className="nl-mirror-frame fig">
          {record ? <div dangerouslySetInnerHTML={{ __html: record.svg }} /> : <span>示意图</span>}
        </div>
      </div>
      {record && <p className="nl-quiet">{tongueColorNote(record) ? tongueColorNote(record) + ' · ' : ''}仅供自己对照</p>}
      <TongueCapture store={store} modelStore={modelStore} minimal onCaptured={async (next, at, crop) => {
        await saveTongue(store, next, at, crop)
        captured.current = true
        setRecord(next); setRecordLabel('今天')
        const blob = new Blob([crop.slice().buffer as ArrayBuffer], { type: 'image/jpeg' })
        setCropUrl(previous => { if (previous) URL.revokeObjectURL(previous); return URL.createObjectURL(blob) })
        setMirrorStatus('已保存舌象裁剪图与候选特征，原图已从应用内清除')
        window.dispatchEvent(new Event('aster:data-changed'))
      }} />
      {mirrorStatus && <p role="status" className="nl-quiet">{mirrorStatus}</p>}
    </section>

    <section className="nl-card" aria-label="今日作业">
      <div className="nl-top"><h2>今日作业</h2>{report.streak > 0 && <span className="nl-streak">已连续 {report.streak} 天</span>}</div>
      {rows.length === 0 && <p className="nl-empty">今天没有安排作业。</p>}
      <div className="nl-homework-scroll">
        {rows.map(row => <div className="nl-homework-row" key={row.homeworkId}>
          <div className="nl-homework-text"><strong>{row.title}</strong><small>{row.note}{row.done ? ' · 今天做了' : ''}</small></div>
          <button type="button" className={'nl-check' + (row.done ? ' done' : '')} disabled={busy || row.done} aria-label={'打卡：' + row.title}
            aria-pressed={row.done} onClick={() => void toggleCheck(row.homeworkId)}>✓</button>
        </div>)}
      </div>
      {rows.length > 0 && <button type="button" className="nl-link-button" onClick={onHomework}>全部作业与近 7 天</button>}
      {error && <p role="alert" className="nl-danger-strong">{error}</p>}
      {status && <p role="status" className="nl-quiet">{status}</p>}
    </section>

    <button type="button" className="nl-link-button" onClick={onConsult}>不舒服？告诉{teacherCall || '老师'}</button>

    <details className="nl-section">
      <summary>今天的完整建议</summary>
      <DailyMirrorCard store={settingsStore} llm={llm} teacher={teacher ?? undefined} />
    </details>
  </div>
}
