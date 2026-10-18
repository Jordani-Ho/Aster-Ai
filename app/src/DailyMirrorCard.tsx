import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import { currentCarePlan } from './core/careplan'
import { loadTeachers } from './core/inbox'
import { loadProfile } from './core/intake/session'
import { listCheckins, type Assignment } from './core/homework'
import { needsNudge } from './core/adherence'
import { getDailyMirror, listSelfRatings, listStressRatings, type MirrorInput, type MirrorResult } from './core/mirror'
import { getWeather, type Weather } from './core/weather'
import { localDay } from './core/homework/schedule'
import { cityByName, heavenAt } from './core/heaven'

const pendingDays = new WeakMap<LocalStore, Map<string, Promise<MirrorResult>>>()
function mirrorForDay(store: LocalStore, input: MirrorInput): Promise<MirrorResult> {
  let days = pendingDays.get(store)
  if (!days) { days = new Map(); pendingDays.set(store, days) }
  const key = localDay(input.now?.() ?? new Date()), prior = days.get(key)
  if (prior) return prior
  const result = getDailyMirror(store, input)
  days.set(key, result)
  void result.finally(() => { if (days.get(key) === result) days.delete(key) }).catch(() => {})
  return result
}

// 只负责读取与展示，建议生成、同日缓存、方案验收都复用 M1-18。
export function DailyMirrorCard({ store, llm, teacher }: { store: LocalStore; llm: LlmClient | null; teacher?: string }) {
  const [result, setResult] = useState<MirrorResult | null>(null)
  const [weather, setWeather] = useState<Weather | null>(null)
  const [date, setDate] = useState(() => localDay(new Date()))
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    const changed = () => setRevision(v => v + 1)
    const tick = () => setDate(localDay(new Date()))
    const timer = setInterval(tick, 60000)
    window.addEventListener('aster:data-changed', changed); window.addEventListener('focus', tick)
    return () => { clearInterval(timer); window.removeEventListener('aster:data-changed', changed); window.removeEventListener('focus', tick) }
  }, [])
  useEffect(() => {
    let active = true
    const run = async () => {
      const at = new Date(), source = teacher ?? (await loadTeachers(store))[0]
      const [plan, profile, checkins, ratings, stress, assignments] = await Promise.all([
        source ? currentCarePlan(store, source) : Promise.resolve(null), loadProfile(store), listCheckins(store), listSelfRatings(store), listStressRatings(store),
        store.list('homework').then(rows => rows.map(row => row.value as unknown as Assignment)),
      ])
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 3000)
      let forecast: Weather | null = null
      try {
        if (profile.city.value) forecast = await getWeather(profile.city.value, { fetch: (url, init) => fetch(url, { ...init, signal: controller.signal }) })
      } finally { clearTimeout(timeout) }
      // 节气按天文时刻换算到学生所在地的当地日期，不再直接拿北京时间。
      const next = await mirrorForDay(store, { carePlan: plan, jieqi: heavenAt(at, cityByName(profile.city.value)).jieqi, weather: forecast, recentCheckins: checkins, recentSymptoms: ratings, recentStress: stress, age: profile.age.value, nudge: needsNudge(assignments, checkins, localDay(at)), ...(llm ? { llm } : {}), now: () => at })
      if (active) { setWeather(forecast); setResult(next); setError('') }
    }
    void run().catch(() => { if (active) setError('每日建议暂未能读取，请稍后重试。') })
    return () => { active = false }
    // 客户端由 App 创建；以本机资料事件和跨日更新触发，不因父组件状态刷新重复起草。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, teacher, date, revision])
  return <section aria-label="每日建议">
    {error && <p role="status">{error}</p>}
    {!result && !error && <p>正在准备今天的建议…</p>}
    {result && <><h3>{result.greeting}</h3><ul>{result.today.map((item, i) => <li key={i}>{item}</li>)}</ul><p>近14天打卡 {result.trend.checkins.reduce((a, b) => a + b, 0)} 次</p></>}
    {weather && <p>今天 {weather.today.tempMin}～{weather.today.tempMax}℃ · 明天 {weather.tomorrow.tempMin}～{weather.tomorrow.tempMax}℃</p>}
  </section>
}
