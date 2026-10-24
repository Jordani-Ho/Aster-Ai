import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import type { PostureMetric } from '../../domain/tcm/posture'
import { POSTURE_FORMULA_FUNCTIONS } from '../../domain/tcm/posture'
import { loadPostureMetrics, savePostureMetrics, validatePostureMetrics } from './core/posture'

// V2-30 老师自己的体态指标：名称 + 公式 + 单位；公式只允许白名单运算与已知关键点。
// 我们只给四条示例，不内置任何正常范围或诊断。
export function PostureMetricsSettings({ store }: { store: LocalStore }) {
  const [rows, setRows] = useState<PostureMetric[]>([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { void loadPostureMetrics(store).then(setRows).catch(() => setError('体态指标读取失败，暂用默认四条。')) }, [store])
  const patch = (index: number, value: Partial<PostureMetric>) => setRows(current => current.map((row, at) => at === index ? { ...row, ...value } : row))
  const save = async () => {
    setError(''); setNotice('')
    const result = validatePostureMetrics(rows)
    if (!result.ok) { setError(result.error ?? '体态指标没填好。'); return }
    try { await savePostureMetrics(store, result.metrics!); setNotice('体态指标已保存，下次记录按新公式算。') } catch { setError('体态指标没有保存成功，请重试。') }
  }
  return <div aria-label="体态指标">
    <p className="nl-quiet">名称 + 公式 + 单位。公式只支持 {POSTURE_FORMULA_FUNCTIONS.join(' / ')}，参数写关键点名（如 left_shoulder、right_hip）；不内置正常范围，也不下诊断。</p>
    <ul className="nl-list">{rows.map((row, index) => <li key={index} className="nl-row" style={{ display: 'block' }}>
      <label>名称<input value={row.name} maxLength={40} onChange={event => patch(index, { name: event.target.value })} /></label>
      <label>公式<input value={row.formula} maxLength={300} onChange={event => patch(index, { formula: event.target.value })} /></label>
      <label>单位<input value={row.unit} maxLength={10} onChange={event => patch(index, { unit: event.target.value })} /></label>
      <button type="button" className="op-link-button" onClick={() => setRows(current => current.filter((_, at) => at !== index))}>删掉这条</button>
    </li>)}</ul>
    <div className="nl-tabs" role="group" aria-label="体态指标操作">
      <button type="button" onClick={() => setRows(current => [...current, { id: 'custom-' + (current.length + 1) + '-' + Date.now().toString(36), name: '', formula: 'heightDiff(left_knee, right_knee)', unit: '%' }])}>加一条指标</button>
      <button type="button" className="nl-primary" onClick={() => void save()}>保存体态指标</button>
    </div>
    {error && <p role="alert" className="nl-danger-strong">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>
}
