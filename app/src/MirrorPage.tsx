import { useEffect, useRef, useState } from 'react'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import { DailyMirrorCard } from './DailyMirrorCard'
import { listSelfRatings, recordSelfRating, listStressRatings, recordStressRating, last14DayTrend, mirrorShichenNotice, mirrorTrendNote, type SelfRating, type StressRating } from './core/mirror/trend'
import { listCheckins, checkIn, dueReminders, habitHomework, type Assignment, type Checkin, type HabitItem } from './core/homework'
import { checkinDay, localDay } from './core/homework/schedule'
import { adherenceReport, type AdherenceReport } from './core/adherence'
import { listTongueDays, saveTonguePhoto, tongueBytes } from './core/tongue'
import { CITY_UNKNOWN_HINT, DEFAULT_MIRROR_SHICHEN, DEFAULT_TIME_DISPLAY, formatHeavenTime, heavenNow, heavenStampOf, loadMirrorShichen, loadTimeDisplay, type HeavenTime, type TimeDisplay } from './core/heaven'
import { MemberSwitcher } from './MemberSwitcher'
import type { FamilyMember } from './core/family'

const DAY_NAMES: Record<number, string> = { 1: '差', 2: '一般', 3: '还行', 4: '不错', 5: '很好' }

export function MirrorPage({ store, llm, family = [], active = 0, onSwitch, member, onCheckedIn }: {
  store: LocalStore
  llm: LlmClient | null
  family?: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active?: number
  onSwitch?: (account: number) => void
  member?: Pick<FamilyMember, 'account' | 'alias'> | null
  /** M1-23a：打卡后把本周坚持率小结发给老师（失败不影响打卡）。 */
  onCheckedIn?: () => void
}) {
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [ratings, setRatings] = useState<SelfRating[]>([])
  const [stressRatings, setStressRatings] = useState<StressRating[]>([])
  const [due, setDue] = useState<{ homeworkId: string; title: string }[]>([])
  const [habits, setHabits] = useState<HabitItem[]>([])
  const [adherence, setAdherence] = useState<AdherenceReport | null>(null)
  const [tongueDays, setTongueDays] = useState<string[]>([])
  const [todayTongue, setTodayTongue] = useState<Uint8Array | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [heaven, setHeaven] = useState<HeavenTime | null>(null)
  const [display, setDisplay] = useState<TimeDisplay>(DEFAULT_TIME_DISPLAY)
  const [mirrorShichen, setMirrorShichen] = useState(DEFAULT_MIRROR_SHICHEN)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const assignmentsRef = useRef<Assignment[]>([])
  const [now] = useState(() => new Date())
  const today = localDay(now)

  // 天时每分钟刷新：时辰按当地真太阳时、节气按天文时刻换算到当地日期。
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      void heavenNow(store).then(time => { if (!cancelled) setHeaven(time) }).catch(() => {})
      void Promise.all([loadTimeDisplay(store), loadMirrorShichen(store)]).then(([mode, shichen]) => {
        if (cancelled) return
        setDisplay(mode); setMirrorShichen(shichen)
      }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 60000)
    window.addEventListener('focus', tick)
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [store])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [checkinList, ratingList, stressList] = await Promise.all([listCheckins(store), listSelfRatings(store), listStressRatings(store)])
        if (cancelled) return
        setCheckins(checkinList); setRatings(ratingList); setStressRatings(stressList)
        const rows = await store.list('homework')
        const assignments = rows.map(row => row.value as unknown as Assignment)
        assignmentsRef.current = assignments
        const reminders = dueReminders(assignments, checkinList, now)
        setDue(reminders.map(item => {
          const assignment = assignments.find(a => a.homework.id === item.homeworkId)
          return { homeworkId: item.homeworkId, title: assignment?.homework.title ?? '作业' }
        }))
        setHabits(habitHomework(assignments, checkinList, now))
        setAdherence(adherenceReport(assignments, checkinList, today))
        setTongueDays(await listTongueDays(store))
        setTodayTongue(await tongueBytes(store, today))
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '镜子页读取失败')
      }
    })()
    return () => { cancelled = true }
  }, [store, now])

  const stamp = heaven ? heavenStampOf(heaven) : undefined

  const complete = async (homeworkId: string) => {
    try {
      await checkIn(store, homeworkId, undefined, new Date(), stamp)
      const fresh = await listCheckins(store)
      setCheckins(fresh)
      setHabits(habitHomework(assignmentsRef.current, fresh, now))
      setAdherence(adherenceReport(assignmentsRef.current, fresh, today))
      setStatus('已保存在本机')
      onCheckedIn?.()
    } catch { setError('打卡未能保存，请重试') }
  }

  const rate = async (score: number) => {
    try {
      await recordSelfRating(store, score, now, stamp)
      setRatings(await listSelfRatings(store))
      setStatus('已记录今天的状态')
    } catch { setError('评分未能保存，请重试') }
  }

  const rateStress = async (score: number) => {
    try {
      await recordStressRating(store, score, now, stamp)
      setStressRatings(await listStressRatings(store))
      setStatus('已记录今天的压力')
    } catch { setError('压力未能保存，请重试') }
  }

  const addTongue = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    try {
      const file = files[0]
      const bytes = new Uint8Array(await file.arrayBuffer())
      const saved = await saveTonguePhoto(store, { bytes, type: file.type || 'image/jpeg' }, { now: () => now, ...(stamp ? { heaven: stamp } : {}) })
      setTodayTongue(await tongueBytes(store, saved.date))
      setTongueDays(await listTongueDays(store))
      setStatus('舌象已保存在本机')
    } catch { setError('舌象保存失败，请重试') }
    finally { if (fileInput.current) fileInput.current.value = '' }
  }

  // 只拿照镜子时辰的镜子记录做对照；其他时辰的记录不参与并给出提示。
  const trend = last14DayTrend(checkins, ratings, stressRatings, now, { shichen: mirrorShichen })
  const trendNote = mirrorTrendNote(trend)
  const shichenNotice = heaven ? mirrorShichenNotice(heaven, mirrorShichen, todayTongue !== null) : null

  return <main className="mirror-page">
    {family.length > 0 && <MemberSwitcher members={family} active={active} onChange={account => onSwitch?.(account)} />}
    <header><p className="eyebrow">知衡 · 学生{member ? ` · ${member.alias}` : ''}</p><h1>镜子</h1>
      {heaven && <p className="mirror-meta">天时：{formatHeavenTime(heaven, display)} · {heaven.jieqi}{heaven.city ? ` · ${heaven.city}` : ''}</p>}
      {heaven && !heaven.solar && <p className="mirror-meta">{CITY_UNKNOWN_HINT}</p>}
    </header>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {shichenNotice && <p role="status">{shichenNotice}</p>}
    <section className="mirror-card"><DailyMirrorCard store={store} llm={llm} /></section>

    <section className="mirror-card">
      <h2>今天的作业</h2>
      {adherence && adherence.streak > 0 && <p className="mirror-meta">已连续练习 {adherence.streak} 天</p>}
      {due.length === 0 && <p>今天没有到点的作业。</p>}
      {due.map(item => {
        const done = checkins.some(record => record.homeworkId === item.homeworkId && checkinDay(new Date(record.at)) === today)
        return <div className="mirror-homework" key={item.homeworkId}>
          <span>{item.title}</span>
          <button disabled={done} onClick={() => void complete(item.homeworkId)}>{done ? '今日已完成 ✓' : '打卡'}</button>
        </div>
      })}
    </section>

    <section className="mirror-card">
      <h2>今天做这些事的时候，记得……</h2>
      {habits.length === 0 && <p>今天没有随习惯的作业。</p>}
      {habits.map(item => <div className="mirror-homework" key={item.homeworkId}>
        <span>{item.anchor}：{item.title}</span>
        <button disabled={item.done} onClick={() => void complete(item.homeworkId)}>{item.done ? '今天已完成 ✓' : '打卡'}</button>
      </div>)}
    </section>

    <section className="mirror-card">
      <h2>拍今天的舌象</h2>
      {todayTongue
        ? <p role="img" aria-label="今天的舌象已保存">已保存今天的舌象。</p>
        : <p>每天一张，只存在你的手机上。</p>}
      <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={event => void addTongue(event.target.files)} />
      <button onClick={() => fileInput.current?.click()}>{todayTongue ? '重拍' : '拍照 / 选择照片'}</button>
      {tongueDays.length > 0 && <p className="mirror-meta">已记录 {tongueDays.length} 天，最近 30 天可回看。</p>}
    </section>

    <section className="mirror-card">
      <h2>今天状态怎么样（1～5 分）</h2>
      <div className="mirror-rating" role="group" aria-label="自评今天状态 1 到 5 分">
        {[1, 2, 3, 4, 5].map(score => <button key={score} onClick={() => void rate(score)}>{score}<span>{DAY_NAMES[score]}</span></button>)}
      </div>
      <h2>今天压力大不大（1～5 分）</h2>
      <div className="mirror-rating" role="group" aria-label="自评今天压力 1 到 5 分">
        {[1, 2, 3, 4, 5].map(score => <button key={score} onClick={() => void rateStress(score)}>{score}<span>{DAY_NAMES[score]}</span></button>)}
      </div>
      {trend.days.length > 0 && <>
        {trendNote && <p className="mirror-meta" role="status">{trendNote}</p>}
        <p className="mirror-meta">状态走势</p>
        <ol className="mirror-trend" aria-label="最近 14 天状态走势">
          {trend.days.map((day, index) => <li key={'s' + day}><span className="mirror-trend-day">{day.slice(5)}</span><span className={trend.scores[index] ? 'mirror-trend-dot done' : 'mirror-trend-dot'}>{trend.scores[index] ?? '·'}</span></li>)}
        </ol>
        <p className="mirror-meta">压力走势</p>
        <ol className="mirror-trend" aria-label="最近 14 天压力走势">
          {trend.days.map((day, index) => <li key={'p' + day}><span className="mirror-trend-day">{day.slice(5)}</span><span className={trend.stress[index] ? 'mirror-trend-dot stress' : 'mirror-trend-dot'}>{trend.stress[index] ?? '·'}</span></li>)}
        </ol>
      </>}
    </section>
  </main>
}
