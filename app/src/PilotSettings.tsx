import { useState } from 'react'
import type { LocalStore } from './core/store'
import { exportMetrics } from './core/pilot'
export function PilotSettings({ store }: { store: LocalStore }) {
  const [error, setError] = useState('')
  return <section><h3>试点指标</h3><p>只在本机导出病历前8位与数值，不含学生身份或病历内容。</p>
    <button onClick={() => void (async () => {
      try {
        const csv = await exportMetrics(store), url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
        const link = document.createElement('a'); link.href = url; link.download = 'aster-pilot-metrics.csv'; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000); setError('')
      } catch { setError('指标导出失败，请检查本机数据后重试。') }
    })()}>导出试点指标</button>{error && <p role="alert">{error}</p>}
  </section>
}
