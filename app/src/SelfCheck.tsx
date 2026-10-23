import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import type { Identity } from './core/identity'
import { last14DayTrend, listSelfRatings, listStressRatings, recordSelfRating, recordStressRating } from './core/mirror/trend'
import { listCheckins } from './core/homework'
import { heavenNow, heavenStampOf } from './core/heaven'
import { OBSERVATION_CHOICES, latestSelfObservation, recordSelfObservation, studentObservationWindow, type ObservationChoice } from './core/kangbi'
import './newui.css'

// V2-10 的“这段时间自己感觉”和 M1-18 的自评/压力走势，从旧的“镜子”页挪到“我”里，只存本机。
const DAY_NAMES: Record<number, string> = { 1: '差', 2: '一般', 3: '还行', 4: '不错', 5: '很好' }

export function SelfCheck({ store, identity, teacher }: { store: LocalStore; identity: Identity; teacher: string | null }) {
  const [selfNote, setSelfNote] = useState<ObservationChoice | null>(null)
  const [status, setStatus] = useState('')
  const [ratings, setRatings] = useState<Awaited<ReturnType<typeof listSelfRatings>>>([])
  const [stress, setStress] = useState<Awaited<ReturnType<typeof listStressRatings>>>([])
  const [trend, setTrend] = useState(() => last14DayTrend([], [], [], new Date()))
  const [busy, setBusy] = useState(false)
  const [now] = useState(() => new Date())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [selfRows, stressRows, checkinRows] = await Promise.all([listSelfRatings(store), listStressRatings(store), listCheckins(store)])
        if (cancelled) return
        setRatings(selfRows); setStress(stressRows)
        setTrend(last14DayTrend(checkinRows, selfRows, stressRows, now))
        if (!teacher) return
        const periodWindow = await studentObservationWindow(store, { teacher })
        const latest = await latestSelfObservation(store, { student: identity.publicKey, teacher, window: periodWindow })
        if (!cancelled) setSelfNote(latest?.choice ?? null)
      } catch { if (!cancelled) setStatus('本机记录暂时读不出来。') }
    })()
    return () => { cancelled = true }
  }, [store, identity.publicKey, teacher, now])

  const stamp = async () => {
    try { return heavenStampOf(await heavenNow(store)) } catch { return undefined }
  }
  const rate = async (value: number) => {
    try { await recordSelfRating(store, value, new Date(), await stamp()); setRatings(await listSelfRatings(store)); setStatus('已记录今天的状态') }
    catch { setStatus('评分没能保存，请重试。') }
  }
  const rateStress = async (value: number) => {
    try { await recordStressRating(store, value, new Date(), await stamp()); setStress(await listStressRatings(store)); setStatus('已记录今天的压力') }
    catch { setStatus('压力没能保存，请重试。') }
  }
  const rateSelf = async (choice: ObservationChoice) => {
    if (!teacher) return
    setBusy(true)
    try { await recordSelfObservation(store, { student: identity.publicKey, teacher, choice }); setSelfNote(choice); setStatus('只记在这台手机上，老师看不到。') }
    catch { setStatus('没记上，请再试一次。') } finally { setBusy(false) }
  }

  return <>
    {teacher && <section className="nl-card" aria-label="这段时间自己感觉">
      <h2>这段时间自己感觉</h2>
      <div className="nl-tabs" role="group" aria-label="这段时间自己感觉">
        {OBSERVATION_CHOICES.map(choice => <button type="button" key={choice.value} aria-pressed={selfNote === choice.value} disabled={busy}
          onClick={() => void rateSelf(choice.value)}>{choice.label}</button>)}
      </div>
      <p className="nl-quiet">只记在这台手机上，老师看不到，也不会随问诊发出去；也可以不记。</p>
    </section>}

    <section className="nl-card" aria-label="自评与压力">
      <h2>今天状态怎么样</h2>
      <div className="nl-tabs" role="group" aria-label="自评今天状态 1 到 5 分">
        {[1, 2, 3, 4, 5].map(score => <button type="button" key={score} onClick={() => void rate(score)}>{score}<small>{DAY_NAMES[score]}</small></button>)}
      </div>
      <h2>今天压力大不大</h2>
      <div className="nl-tabs" role="group" aria-label="自评今天压力 1 到 5 分">
        {[1, 2, 3, 4, 5].map(score => <button type="button" key={score} onClick={() => void rateStress(score)}>{score}<small>{DAY_NAMES[score]}</small></button>)}
      </div>
      {ratings.length > 0 && <p className="nl-quiet">状态最近：{ratings.slice(-5).map(item => item.date.slice(5) + ' ' + item.score).join(' · ')}</p>}
      {stress.length > 0 && <p className="nl-quiet">压力最近：{stress.slice(-5).map(item => item.date.slice(5) + ' ' + item.score).join(' · ')}</p>}
      {trend.days.length > 0 && <p className="nl-quiet">近 14 天打卡 {trend.checkins.reduce((sum, count) => sum + count, 0)} 次</p>}
      {status && <p role="status" className="nl-quiet">{status}</p>}
    </section>
  </>
}
