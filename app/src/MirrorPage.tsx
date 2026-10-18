import { useEffect, useRef, useState } from 'react'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { CarePlan } from './core/careplan'
import { listCarePlans } from './core/careplan'
import { getDailyMirror, type MirrorResult } from './core/mirror'
import { listSelfRatings, recordSelfRating, listStressRatings, recordStressRating, last14DayTrend, type StressRating } from './core/mirror/trend'
import { getWeather, type Weather } from './core/weather'
import { currentJieqi, seasonalTexts } from '../../domain/tcm/seasonal'
import { listCheckins, checkIn, dueReminders, type Checkin } from './core/homework'
import { localDay } from './core/homework/schedule'
import { listTongueDays, saveTonguePhoto, tongueBytes } from './core/tongue'
import { loadProfile } from './core/intake'

const DAY_NAMES: Record<number, string> = { 1: '差', 2: '一般', 3: '还行', 4: '不错', 5: '很好' }

export function MirrorPage({ store, llm }: { store: LocalStore; llm: LlmClient | null }) {
  const [mirror, setMirror] = useState<MirrorResult | null>(null)
  const [weather, setWeather] = useState<Weather | null>(null)
  const [jieqi, setJieqi] = useState('')
  const [seasonal, setSeasonal] = useState('')
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [stressRatings, setStressRatings] = useState<StressRating[]>([])
  const [due, setDue] = useState<{ homeworkId: string; title: string }[]>([])
  const [tongueDays, setTongueDays] = useState<string[]>([])
  const [todayTongue, setTodayTongue] = useState<Uint8Array | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [now] = useState(() => new Date())
  const today = localDay(now)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const plans = await listCarePlans(store)
        const carePlan: CarePlan | null = plans.length === 0 ? null
          : plans.map(item => item.plan).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
        const jieqiName = currentJieqi(now)
        setJieqi(jieqiName)
        const texts = seasonalTexts(jieqiName)
        setSeasonal(texts ? `${texts.living}；${texts.diet}；${texts.emotion}` : '')
        const profile = await loadProfile(store)
        const city = profile.city.value
        const weatherData = city ? await getWeather(city) : null
        setWeather(weatherData)
        const ratings = await listSelfRatings(store)
        const stress = await listStressRatings(store)
        const checkinList = await listCheckins(store)
        setCheckins(checkinList)
        setStressRatings(stress)
        const result = await getDailyMirror(store, {
          carePlan, jieqi: jieqiName, weather: weatherData,
          recentCheckins: checkinList, recentSymptoms: ratings, recentStress: stress, llm: llm ?? undefined,
          now: () => now,
        })
        if (!cancelled) setMirror(result)
        const rows = await store.list('homework')
        const assignments = rows.map(row => row.value as unknown as { homework: { id: string; title: string }; startsOn: string })
        const reminders = dueReminders(assignments as never, checkinList, now)
        if (!cancelled) setDue(reminders.map(item => {
          const assignment = assignments.find(a => a.homework.id === item.homeworkId)
          return { homeworkId: item.homeworkId, title: assignment?.homework.title ?? '作业' }
        }))
        const days = await listTongueDays(store)
        setTongueDays(days)
        const photo = await tongueBytes(store, today)
        setTodayTongue(photo)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '镜子页读取失败')
      }
    })()
    return () => { cancelled = true }
  }, [store, llm, now])

  const complete = async (homeworkId: string) => {
    try {
      const record = await checkIn(store, homeworkId)
      setCheckins(previous => [...previous, record])
      setStatus('已保存在本机')
    } catch { setError('打卡未能保存，请重试') }
  }

  const rate = async (score: number) => {
    try {
      await recordSelfRating(store, score, now)
      const ratings = await listSelfRatings(store)
      const trend = last14DayTrend(checkins, ratings, stressRatings, now)
      setMirror(previous => previous ? { ...previous, trend } : previous)
      setStatus('已记录今天的状态')
    } catch { setError('评分未能保存，请重试') }
  }

  const rateStress = async (score: number) => {
    try {
      await recordStressRating(store, score, now)
      const stress = await listStressRatings(store)
      setStressRatings(stress)
      const ratings = await listSelfRatings(store)
      const trend = last14DayTrend(checkins, ratings, stress, now)
      setMirror(previous => previous ? { ...previous, trend } : previous)
      setStatus('已记录今天的压力')
    } catch { setError('压力未能保存，请重试') }
  }

  const addTongue = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    try {
      const file = files[0]
      const bytes = new Uint8Array(await file.arrayBuffer())
      const saved = await saveTonguePhoto(store, { bytes, type: file.type || 'image/jpeg' }, { now: () => now })
      setTodayTongue(await tongueBytes(store, saved.date))
      setTongueDays(await listTongueDays(store))
      setStatus('舌象已保存在本机')
    } catch { setError('舌象保存失败，请重试') }
    finally { if (fileInput.current) fileInput.current.value = '' }
  }

  const trend = mirror?.trend ?? last14DayTrend(checkins, [], [], now)
  const weatherLine = weather
    ? `${weather.today.tempMin}~${weather.today.tempMax}℃ 降水 ${weather.today.precipitation}mm；明天 ${weather.tomorrow.tempMin}~${weather.tomorrow.tempMax}℃`
    : ''

  return <main className="mirror-page">
    <header><p className="eyebrow">知衡 · 学生</p><h1>镜子</h1><p>{jieqi}{seasonal ? ' · ' + localDay(now) : ''}</p></header>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    <section className="mirror-card">
      <h2>{mirror?.greeting ?? '你好'}</h2>
      {weatherLine && <p className="mirror-weather">今天 {weatherLine}</p>}
      {mirror && <ul className="mirror-today">{mirror.today.map((item, index) => <li key={index}>{item}</li>)}</ul>}
      {!mirror && <p>正在准备今天的建议…</p>}
    </section>

    <section className="mirror-card">
      <h2>今天的作业</h2>
      {due.length === 0 && <p>今天没有到点的作业。</p>}
      {due.map(item => {
        const done = checkins.some(record => record.homeworkId === item.homeworkId && localDay(new Date(record.at)) === today)
        return <div className="mirror-homework" key={item.homeworkId}>
          <span>{item.title}</span>
          <button disabled={done} onClick={() => void complete(item.homeworkId)}>{done ? '今日已完成 ✓' : '打卡'}</button>
        </div>
      })}
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
