import { useEffect, useState } from 'react'
import type { LocalStore } from './core/store'
import { dashboardConfig } from './core/dashboard/config'
import { buildDailyStats, loadStatsShare, saveStatsShare } from './core/dashboard/stats'
import type { DailyStats } from './core/dashboard/types'
import './dashboard.css'

const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env

// V2-14：老师能看到“今天发出去的就是这几行数字”；开关默认开，关了就什么都不发。
export function StatsSharing({ store }: { store: LocalStore }) {
  const config = dashboardConfig(env)
  const [enabled, setEnabled] = useState(true)
  const [stats, setStats] = useState<DailyStats | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = () => {
      void Promise.all([loadStatsShare(store), buildDailyStats(store).catch(() => null)])
        .then(([on, value]) => { if (active) { setEnabled(on); setStats(value); setError('') } })
        .catch(() => { if (active) setError('统计暂时读不出来，请稍后重试。') })
    }
    load()
    window.addEventListener('aster:data-changed', load)
    return () => { active = false; window.removeEventListener('aster:data-changed', load) }
  }, [store])

  const toggle = async () => {
    const next = !enabled
    setEnabled(next); setError('')
    try { await saveStatsShare(store, next) } catch { setEnabled(!next); setError('开关没有保存成功，请重试。') }
  }

  return <section aria-label="向社区分享运行统计">
    <label className="stats-toggle"><input type="checkbox" checked={enabled} onChange={() => void toggle()} /> 向社区分享运行统计</label>
    <p className="inbox-note">每天打开应用时汇总一次；只发计数、时长和错误类型，不含病历、舌象、钱账、名字、城市、学生本人感受。</p>
    {!config.configured && <p className="inbox-note">部署还没有配置社区仪表盘公钥/地址，当前不会发送。</p>}
    {error && <p role="alert">{error}</p>}
    {!enabled
      ? <p>已关闭，今天什么都不发。</p>
      : stats
        ? <div className="stats-preview">
          <p>今天发出去的就是这几行数字：</p>
          <dl>
            <dt>格式版本</dt><dd>{stats.version}</dd>
            <dt>应用版本</dt><dd>{stats.appVersion}</dd>
            <dt>本馆 ID</dt><dd>{stats.hallId}</dd>
            <dt>日期</dt><dd>{stats.date}</dd>
            <dt>服务在线时长</dt><dd>{stats.onlineSeconds} 秒</dd>
            <dt>出错次数</dt><dd>未捕获错误 {stats.errorCounts.uncaughtError} 次 · 未处理 Promise {stats.errorCounts.unhandledRejection} 次</dd>
            <dt>当天收到的问诊</dt><dd>{stats.consults} 份</dd>
            <dt>签字</dt><dd>{stats.signatures} 份</dd>
            <dt>签字平均用时</dt><dd>{stats.avgSignMinutes === null ? '—（没有签字）' : stats.avgSignMinutes + ' 分钟'}</dd>
            <dt>作业打卡</dt><dd>{stats.homeworkCheckins === null ? '—（本机没有数据）' : stats.homeworkCheckins + ' 次'}</dd>
            <dt>舌象记录</dt><dd>{stats.tongueRecords} 条</dd>
            <dt>学生人数</dt><dd>{stats.students} 人</dd>
          </dl>
        </div>
        : <p>正在汇总今天的数据…</p>}
    {config.url && <p className="inbox-note"><a href={config.url} target="_blank" rel="noopener noreferrer">查看社区仪表盘（只读）</a></p>}
  </section>
}
