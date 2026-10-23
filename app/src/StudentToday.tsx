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
  member?: Pick<FamilyMember, 'account' | 'alias'> | null
  family?: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active?: number
  onSwitch?: (account: number) => void
  onConsult: () => void
  onHomework: () => void
  onCheckedIn: () => void
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
  store, modelStore, settingsStore, llm, teacher, teacherCall, teacherName,
  member, family = [], active = 0, onSwitch, onConsult, onHomework, onCheckedIn,
}: StudentTodayProps) {
  const [now, setNow] = useState(() => new Date())
  const [heaven, setHeaven] = useState<HeavenTime | null>(null)
  const [plan, setPlan] = useState<CarePlan | null>(null)
  const [alias, setAlias] = useState('')
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [record, setRecord] = useState<TongueAbstract | null>(null)
  const [recordLabel, setRecordLabel] = useState('上次')
  const [cropUrl, setCropUrl] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
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

  useEffect(() => () => { if (cropUrl) URL.revokeObjectURL(cropUrl) }, [cropUrl])

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

  const toggleCheck = async (homeworkId: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await checkIn(store, homeworkId, undefined, new Date(), stamp)
      setCheckins(await listCheckins(store))
      setNow(new Date())
      setStatus('已记在这台手机上')
      onCheckedIn()
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
        setStatus('已保存舌象裁剪图与候选特征，原图已从应用内清除')
      }} />
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
