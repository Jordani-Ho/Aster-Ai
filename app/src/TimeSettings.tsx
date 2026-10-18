import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import { loadProfile, saveProfile } from './core/intake/session'
import { cities } from '../../domain/tcm/bazi'
import {
  CITY_UNKNOWN_HINT, DEFAULT_MIRROR_SHICHEN, DEFAULT_TIME_DISPLAY, SHICHEN,
  formatHeavenTime, heavenNow, loadMirrorShichen, loadTimeDisplay, saveMirrorShichen, saveTimeDisplay,
  type HeavenTime, type TimeDisplay,
} from './core/heaven'

// V2-02 天时设置：居住城市（算真太阳时）、两种时间显示、照镜子时辰。
// 这些都是表层配置（数据），界面只读不改逻辑；以后由各自的智能体按主人习惯调整。
export function TimeSettings({ store }: { store: LocalStore }) {
  const [city, setCity] = useState('')
  const [display, setDisplay] = useState<TimeDisplay>(DEFAULT_TIME_DISPLAY)
  const [shichen, setShichen] = useState(DEFAULT_MIRROR_SHICHEN)
  const [time, setTime] = useState<HeavenTime | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void Promise.all([loadProfile(store), loadTimeDisplay(store), loadMirrorShichen(store)]).then(([profile, mode, chosen]) => {
      if (cancelled) return
      setCity(profile.city.value ?? '')
      setDisplay(mode); setShichen(chosen)
    }).catch(() => { if (!cancelled) setError('时间设置暂时无法读取。') })
    return () => { cancelled = true }
  }, [store])

  useEffect(() => {
    let cancelled = false
    void heavenNow(store).then(result => { if (!cancelled) setTime(result) }).catch(() => {})
    return () => { cancelled = true }
  }, [store, city, display, shichen])

  const changeCity = async (value: string) => {
    setError(''); setStatus('')
    try {
      const profile = await loadProfile(store)
      await saveProfile(store, { ...profile, city: value === '' ? { value: null, source: 'unknown' } : { value, source: 'student' } })
      setCity(value); setStatus(value === '' ? '已清除居住城市' : '已保存居住城市')
    } catch { setError('居住城市未能保存，请重试。') }
  }

  const changeDisplay = async (value: TimeDisplay) => {
    setError('')
    try { await saveTimeDisplay(store, value); setDisplay(value) } catch { setError('时间显示方式未能保存。') }
  }

  const changeShichen = async (value: string) => {
    setError('')
    try { await saveMirrorShichen(store, value); setShichen(value) } catch { setError('照镜子时辰未能保存。') }
  }

  return <section aria-label="我的时间">
    <h3>我的时间</h3>
    <p>时辰按当地真太阳时算，节气按天文时刻换算成当地日期。</p>
    <label>居住城市<select value={city} onChange={event => void changeCity(event.target.value)}>
      <option value="">未设置</option>
      {cities.map(item => <option key={item.nameZh} value={item.nameZh}>{item.nameZh}</option>)}
    </select></label>
    {city === '' && <p role="status">{CITY_UNKNOWN_HINT}</p>}
    <label>时间显示<select value={display} onChange={event => void changeDisplay(event.target.value as TimeDisplay)}>
      <option value="both">时辰和钟点都显示</option>
      <option value="shichen">只看时辰</option>
      <option value="clock">只看钟点</option>
    </select></label>
    <label>照镜子时辰<select value={shichen} onChange={event => void changeShichen(event.target.value)}>
      {SHICHEN.map(name => <option key={name} value={name}>{name}时</option>)}
    </select></label>
    <p>到{shichen}时会提醒照镜子；其他时辰的记录不参与走势对照。</p>
    {time && <p>此刻：{formatHeavenTime(time, display)} · {time.jieqi}{time.city ? ` · ${time.city}` : ''}</p>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
  </section>
}
