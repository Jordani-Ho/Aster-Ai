import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import type { Identity } from './core/identity'
import type { SendEnvelope } from './core/inbox'
import { notifyStudentsOfTeacherCityChange, notifyTeachersOfCityChange } from './core/city'
import { loadProfile, saveProfile } from './core/intake/session'
import { cities } from '../../domain/tcm/bazi'
import {
  CITY_UNKNOWN_HINT, DEFAULT_MIRROR_SHICHEN, DEFAULT_TIME_DISPLAY, SHICHEN,
  formatHeavenTime, heavenNow, loadMirrorShichen, loadTimeDisplay, saveMirrorShichen, saveTimeDisplay,
  type HeavenTime, type TimeDisplay,
} from './core/heaven'

// V2-02 天时设置：居住城市（算真太阳时）、两种时间显示、照镜子时辰。
// 这些都是表层配置（数据），界面只读不改逻辑；以后由各自的智能体按主人习惯调整。
export function TimeSettings({ store, identity, sendEnvelope, cityOnly = false }: { store: LocalStore; identity?: Identity; sendEnvelope?: SendEnvelope; cityOnly?: boolean }) {
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
      const role = await store.get('settings', 'role') as { role?: unknown } | undefined
      const citySource = role?.role === 'teacher' ? 'teacher' : 'student'
      await saveProfile(store, { ...profile, city: value === '' ? { value: null, source: 'unknown' } : { value, source: citySource } })
      const nextCity = value || null
      let syncFailed = false
      if (identity && profile.city.value !== nextCity) {
        try {
          if (!sendEnvelope) throw new Error('offline')
          if (role?.role === 'teacher') {
            const students = (await store.list('teacher-students')).map(row => row.key)
            await notifyStudentsOfTeacherCityChange({ identity: identity.publicKey, previous: profile.city.value ?? null, city: nextCity, students, send: sendEnvelope })
          } else {
            const teachers = await store.get('settings', 'teachers')
            await notifyTeachersOfCityChange({ identity: identity.publicKey, previous: profile.city.value ?? null, city: nextCity,
              teachers: Array.isArray(teachers) ? teachers.filter((item): item is string => typeof item === 'string') : [], send: sendEnvelope })
          }
        } catch { syncFailed = true }
      }
      setCity(value); setStatus(syncFailed ? '已保存居住城市，城市更新暂时没发给老师；连接中继后请再改一次城市。' : value === '' ? '已清除居住城市' : '已保存居住城市')
      if (profile.city.value !== nextCity) window.dispatchEvent(new Event('aster:data-changed'))
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

  return <section aria-label={cityOnly ? '老师所在城市' : '我的时间'}>
    <h3>{cityOnly ? '老师所在城市' : '我的时间'}</h3>
    {!cityOnly && <p>时辰按当地真太阳时算，节气按天文时刻换算成当地日期。</p>}
    <label>居住城市<select value={city} onChange={event => void changeCity(event.target.value)}>
      <option value="">未设置</option>
      {cities.map(item => <option key={item.nameZh} value={item.nameZh}>{item.nameZh}</option>)}
    </select></label>
    {city === '' && <p role="status">{CITY_UNKNOWN_HINT}</p>}
    {!cityOnly && <label>时间显示<select value={display} onChange={event => void changeDisplay(event.target.value as TimeDisplay)}>
      <option value="both">时辰和钟点都显示</option>
      <option value="shichen">只看时辰</option>
      <option value="clock">只看钟点</option>
    </select></label>}
    {!cityOnly && <label>照镜子时辰<select value={shichen} onChange={event => void changeShichen(event.target.value)}>
      {SHICHEN.map(name => <option key={name} value={name}>{name}时</option>)}
    </select></label>}
    {!cityOnly && <p>到{shichen}时会提醒照镜子；其他时辰的记录不参与走势对照。</p>}
    {!cityOnly && time && <p>此刻：{formatHeavenTime(time, display)} · {time.jieqi}{time.city ? ` · ${time.city}` : ''}</p>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
  </section>
}
