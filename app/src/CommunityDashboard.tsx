import { useEffect, useState } from 'react'
import { createTransport } from './core/transport'
import { dashboardKeyFromHash } from './core/dashboard/config'
import { errorTotal, groupStats, statsFromEnvelope } from './core/dashboard/dashboard'
import type { DailyStats } from './core/dashboard/types'
import { localDay } from './core/homework/schedule'
import './dashboard.css'

// V2-14 只读社区仪表盘：没有表单、按钮、链接，也不显示任何可改变馆的操作。
// 解密私钥只在查看者自己的浏览器里（URL hash 读一次后放 sessionStorage），不进仓库、不进馆的 .env。
const SESSION_KEY = 'aster-dashboard-key'

function readKey(): string | null {
  const fromHash = dashboardKeyFromHash(location.hash)
  try {
    if (fromHash) {
      sessionStorage.setItem(SESSION_KEY, fromHash)
      history.replaceState(null, '', location.pathname + location.search)
    }
    const stored = sessionStorage.getItem(SESSION_KEY)
    return stored && /^[0-9a-f]{64}$/.test(stored) ? stored : null
  } catch { return fromHash }
}

function keyBytes(hex: string): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))
}

function duration(seconds: number): string {
  if (seconds < 60) return seconds + ' 秒'
  if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟'
  return (Math.round(seconds / 360) / 10) + ' 小时'
}

export function CommunityDashboard({ relays }: { relays: readonly string[] }) {
  const [key] = useState<string | null>(readKey)
  const [records, setRecords] = useState<DailyStats[]>([])
  const [status, setStatus] = useState<'offline' | 'connecting' | 'ready' | 'rejected'>('offline')
  useEffect(() => {
    if (!key || relays.length === 0) return
    const transport = createTransport({
      privateKey: keyBytes(key), relays: [...relays],
      onMessage: message => {
        const stats = statsFromEnvelope(message.envelope)
        if (!stats) return
        setRecords(previous => previous.some(item => item.hallId === stats.hallId && item.date === stats.date) ? previous : [...previous, stats])
      },
      onStatus: value => setStatus(value === 'connecting' || value === 'ready' || value === 'rejected' ? value : 'offline'),
    })
    transport.start()
    return () => transport.close()
  }, [key, relays.join(',')])

  const groups = groupStats(records, localDay(new Date()))
  return <main className="dashboard-page">
    <h1>社区仪表盘</h1>
    <p>只读：这里只显示各馆自己交的统计数字，不能修改任何馆、设置或发消息。</p>
    {!key
      ? <p>没有解密钥匙，不显示任何数据。</p>
      : relays.length === 0
        ? <p>还没有配置社区中继，暂时收不到统计。</p>
        : <p role="status">{status === 'ready' ? '已连接社区中继' : status === 'connecting' ? '正在连接社区中继' : status === 'rejected' ? '中继拒绝连接' : '等待连接社区中继'}</p>}
    {key && groups.length === 0 && <p>最近 30 天还没有收到统计。</p>}
    {groups.map(group => <section className="dashboard-hall" key={group.hallId}>
      <h2>馆 {group.hallId.slice(0, 8)}</h2>
      <div className="dashboard-scroll">
        <table>
          <thead><tr>
            <th>日期</th><th>应用版本</th><th>在线时长</th><th>出错</th><th>问诊</th><th>签字</th>
            <th>签字平均用时</th><th>作业打卡</th><th>舌象</th><th>学生</th>
          </tr></thead>
          <tbody>
            {group.days.map(record => <tr key={record.date}>
              <td>{record.date}</td>
              <td>{record.appVersion}</td>
              <td>{duration(record.onlineSeconds)}</td>
              <td>{errorTotal(record)}</td>
              <td>{record.consults}</td>
              <td>{record.signatures}</td>
              <td>{record.avgSignMinutes === null ? '—' : record.avgSignMinutes + ' 分钟'}</td>
              <td>{record.homeworkCheckins === null ? '—' : record.homeworkCheckins}</td>
              <td>{record.tongueRecords}</td>
              <td>{record.students}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>)}
  </main>
}
