import { useEffect, useRef, useState } from 'react'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import { DailyMirrorCard } from './DailyMirrorCard'
import { listSelfRatings, recordSelfRating, listStressRatings, recordStressRating, last14DayTrend, mirrorShichenNotice, mirrorTrendNote, type SelfRating, type StressRating } from './core/mirror/trend'
import { listCheckins, checkIn, dueReminders, habitHomework, type Assignment, type Checkin, type HabitItem } from './core/homework'
import { checkinDay, effectiveDay, localDay } from './core/homework/schedule'
import { adherenceReport, type AdherenceReport } from './core/adherence'
import { listTongueDays, latestTongueCrop, saveTongue, loadTongue, type TongueCropRow } from './core/tongue'
import type { TongueAbstract } from '../../domain/tcm/tongue'
import { TongueCapture } from './TongueCapture'
import { TonguePair } from './TonguePair'
import { CITY_UNKNOWN_HINT, DEFAULT_MIRROR_SHICHEN, DEFAULT_TIME_DISPLAY, formatHeavenTime, heavenNow, heavenStampOf, loadMirrorShichen, loadTimeDisplay, type HeavenTime, type TimeDisplay } from './core/heaven'
import { MemberSwitcher } from './MemberSwitcher'
import type { FamilyMember } from './core/family'
import type { Identity } from './core/identity'
import { OBSERVATION_CHOICES, latestSelfObservation, recordSelfObservation, studentObservationWindow, type ObservationChoice } from './core/kangbi'

const DAY_NAMES: Record<number, string> = { 1: '差', 2: '一般', 3: '还行', 4: '不错', 5: '很好' }

export function MirrorPage({ store, modelStore, settingsStore, llm, family = [], active = 0, onSwitch, member, onCheckedIn, teacher, identity }: {
  store: LocalStore
  modelStore?: LocalStore
  /** V2-06：时间显示方式与照镜子时辰沿用管理人的设置（家人不单独设）。 */
  settingsStore?: LocalStore
  llm: LlmClient | null
  family?: readonly Pick<FamilyMember, 'account' | 'alias'>[]
  active?: number
  onSwitch?: (account: number) => void
  member?: Pick<FamilyMember, 'account' | 'alias'> | null
  /** M1-23a：打卡后把本周坚持率小结发给老师（失败不影响打卡）。 */
  onCheckedIn?: () => void
  /** V2-09：当前在用的馆；每日建议取这位老师的调养方案。 */
  teacher?: string | null
  /** V2-10：本人感受只记在本人本机；没有身份（测试夹具）时不显示这一块。 */
  identity?: Identity
}) {
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [ratings, setRatings] = useState<SelfRating[]>([])
  const [stressRatings, setStressRatings] = useState<StressRating[]>([])
  const [due, setDue] = useState<{ homeworkId: string; title: string }[]>([])
  const [habits, setHabits] = useState<HabitItem[]>([])
  const [adherence, setAdherence] = useState<AdherenceReport | null>(null)
  const [tongueDays, setTongueDays] = useState<string[]>([])
  const [todayTongue, setTodayTongue] = useState<TongueAbstract | null>(null)
  const [latestCrop, setLatestCrop] = useState<TongueCropRow | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [heaven, setHeaven] = useState<HeavenTime | null>(null)
  const [display, setDisplay] = useState<TimeDisplay>(DEFAULT_TIME_DISPLAY)
  const [mirrorShichen, setMirrorShichen] = useState(DEFAULT_MIRROR_SHICHEN)
  const assignmentsRef = useRef<Assignment[]>([])
  const [now] = useState(() => new Date())
  // V2-10：本人这一句只存在本机；老师看不到，也不随问诊包发出。
  const [selfNote, setSelfNote] = useState<ObservationChoice | null>(null)
  const [selfStatus, setSelfStatus] = useState('')
  // 打卡相关一律用 effectiveDay（与 checkinDay 同一口径）；舌象按自然日存档，用 calendarToday。
  const today = effectiveDay(now)
  const calendarToday = localDay(now)

  // 天时每分钟刷新：时辰按当地真太阳时、节气按天文时刻换算到当地日期。
  // 家人只按自己的档案城市算天时；时间显示方式与照镜子时辰沿用管理人（settingsStore）。
  useEffect(() => {
    let cancelled = false
    const settings = settingsStore ?? store
    const tick = () => {
      void heavenNow(store).then(time => { if (!cancelled) setHeaven(time) }).catch(() => {})
      void Promise.all([loadTimeDisplay(settings), loadMirrorShichen(settings)]).then(([mode, shichen]) => {
        if (cancelled) return
        setDisplay(mode); setMirrorShichen(shichen)
      }).catch(() => {})
    }
    tick()
    const timer = setInterval(tick, 60000)
    window.addEventListener('focus', tick)
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', tick) }
  }, [store, settingsStore])

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
        setTodayTongue(await loadTongue(store, calendarToday))
        setLatestCrop(await latestTongueCrop(store))
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '镜子页读取失败')
      }
    })()
    return () => { cancelled = true }
  }, [store, now])

  const stamp = heaven ? heavenStampOf(heaven) : undefined

  useEffect(() => {
    if (!identity || !teacher) { setSelfNote(null); return }
    let cancelled = false
    void (async () => {
      try {
        const window = await studentObservationWindow(store, { teacher })
        const latest = await latestSelfObservation(store, { student: identity.publicKey, teacher, window })
        if (!cancelled) setSelfNote(latest?.choice ?? null)
      } catch { /* 读不到本人感受不影响镜子其它内容 */ }
    })()
    return () => { cancelled = true }
  }, [store, identity, teacher])

  const rateSelf = async (choice: ObservationChoice) => {
    if (!identity || !teacher) return
    try {
      await recordSelfObservation(store, { student: identity.publicKey, teacher, choice })
      setSelfNote(choice)
      setSelfStatus('已记在这台手机上，只有你能看到。')
    } catch { setSelfStatus('没记上，请再试一次。') }
  }

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
    <section className="mirror-card"><DailyMirrorCard store={store} llm={llm} teacher={teacher ?? undefined} /></section>

    {identity && teacher && <section className="mirror-card" aria-label="这段时间自己感觉">
      <h2>这段时间自己感觉</h2>
      <div className="mirror-rating" role="group" aria-label="这段时间自己感觉">
        {OBSERVATION_CHOICES.map(choice => <button key={choice.value} aria-pressed={selfNote === choice.value} onClick={() => void rateSelf(choice.value)}>{choice.label}</button>)}
      </div>
      <p className="mirror-meta">只记在这台手机上，老师看不到，也不会随问诊发出去；也可以不记。</p>
      {selfStatus && <p className="mirror-meta" role="status">{selfStatus}</p>}
    </section>}

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
        ? <TonguePair
            record={todayTongue}
            crop={latestCrop && todayTongue.crop && latestCrop.id === todayTongue.crop.id ? latestCrop.data : null}
            cropState={!todayTongue.crop ? 'missing' : latestCrop?.id === todayTongue.crop.id ? 'ok' : 'replaced'}
            studentNote
            title={`${member ? member.alias : '本人'} · 今天 · ${todayTongue.shichen}时`}
          />
        : <p>照片交给你接入的视觉模型读取，只留下舌头裁剪图和候选特征，应用不保留原图。</p>}
      <TongueCapture store={store} modelStore={modelStore} onCaptured={async(record,at,crop)=>{await saveTongue(store,record,at,crop);setTodayTongue(record);setLatestCrop(await latestTongueCrop(store));setTongueDays(await listTongueDays(store));setStatus('已保存舌象裁剪图与候选特征，原图已从应用内清除')}}/>
      {tongueDays.length > 0 && <p className="mirror-meta">已记录 {tongueDays.length} 天。</p>}
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
