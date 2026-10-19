import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import { TONGUE_LEVEL_DEFAULT, TONGUE_LEVELS, loadTongueLevel, saveTongueLevel, tongueLevelLabel, type TongueLevel } from './core/tongue/level'

// V2-08：舌象抽象级别只做第一级；第三级（只留特征值）不开放，界面上也不给入口。
export function TongueLevelSettings({ store }: { store: LocalStore }) {
  const [level, setLevel] = useState<TongueLevel>(TONGUE_LEVEL_DEFAULT)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void loadTongueLevel(store).then(value => { if (active) setLevel(value) }).catch(() => { if (active) setError('舌象级别暂时无法读取。') })
    return () => { active = false }
  }, [store])
  return <section aria-label="舌象级别">
    <h2>舌象级别</h2>
    <p>第一级只留舌头裁剪图和模型候选特征，由老师逐项定值；老师改过的值只以计数形式记进改稿习惯，长期保留。</p>
    <label>级别<select value={level} onChange={async event => {
      setError(''); setStatus('')
      const next = Number(event.target.value) as TongueLevel
      try { await saveTongueLevel(store, next); setLevel(next); setStatus('已保存。') }
      catch { setError('本版只开放第一级。') }
    }}>{TONGUE_LEVELS.map(value => <option key={value} value={value}>{tongueLevelLabel(value)}</option>)}</select></label>
    <p className="inbox-note">第三级（只留特征值、不留裁剪图）暂不开放。</p>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
  </section>
}
