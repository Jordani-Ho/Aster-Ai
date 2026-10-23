import { useEffect, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import { groupReceivedRecords, listReceivedRecords, type GroupedRecord } from './core/inbox'
import { listCheckins, type Assignment } from './core/homework'
import { effectiveDay, localDay } from './core/homework/schedule'
import { listTongueDays, loadTongue, latestTongueCrop } from './core/tongue'
import { tongueFeatureShortText, type TongueAbstract } from '../../domain/tcm/tongue'
import { weeklyTrend, trendCaption } from './records-trend'
import { useTeacherVenue } from './useTeacherVenue'
import './newui.css'

// V2-17 学生·记录（11）：我的病历、舌象的变化、坚持的趋势。
// 病历只显示验签通过的；舌象只存裁剪图与候选特征；趋势只从本机打卡与作业排程算。
export interface StudentRecordsHomeProps {
  store: LocalStore
  identity: Identity
  onOpenAllRecords: () => void
}

interface TongueItem { day: string; label: string; record: TongueAbstract; crop: Uint8Array | null }

function dayLabel(day: string, today: string): string {
  if (day === today) return '今天'
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  return parsed ? `${Number(parsed[2])}月${Number(parsed[3])}日` : day
}

function groupLabel(group: GroupedRecord): string {
  const date = new Date(group.versions[0].encounter.createdAt)
  const kind = group.versions[0].encounter.version > 1 ? '复诊' : group.versions[0].encounter.kind === 'in_person' ? '面诊' : '初诊'
  return `${date.getMonth() + 1}月${date.getDate()}日 · ${kind}`
}

export function StudentRecordsHome({ store, identity, onOpenAllRecords }: StudentRecordsHomeProps) {
  const venue = useTeacherVenue(store)
  const [groups, setGroups] = useState<GroupedRecord[]>([])
  const [tongues, setTongues] = useState<TongueItem[]>([])
  const [trend, setTrend] = useState(() => weeklyTrend([], [], localDay(new Date()), 4))
  const [caption, setCaption] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const [records, days, latestCrop, rows, checkins] = await Promise.all([
          listReceivedRecords(store, identity), listTongueDays(store), latestTongueCrop(store), store.list('homework'), listCheckins(store),
        ])
        if (!active) return
        setGroups(groupReceivedRecords(records))
        const today = localDay(new Date())
        const items: TongueItem[] = []
        for (const day of days.slice().sort().reverse().slice(0, 3)) {
          const record = await loadTongue(store, day)
          if (!record) continue
          const crop = latestCrop && record.crop && latestCrop.id === record.crop.id ? latestCrop.data : null
          items.push({ day, label: dayLabel(day, today), record, crop })
        }
        setTongues(items)
        const assignments = rows.map(row => row.value as unknown as Assignment)
        const weeks = weeklyTrend(assignments, checkins, effectiveDay(new Date()), 4)
        setTrend(weeks); setCaption(trendCaption(weeks)); setError('')
      } catch { if (active) setError('本机记录读取失败，请稍后重试。') }
    })()
    return () => { active = false }
  }, [store, identity])

  const maxDone = Math.max(7, ...trend.map(week => week.done))
  const points = trend.map((week, index) => {
    const x = 20 + index * (320 / Math.max(trend.length - 1, 1))
    const y = 100 - Math.round((week.done / maxDone) * 76)
    return { x, y, week }
  })
  const line = points.map(point => `${point.x},${point.y}`).join(' ')

  return <div className="nl-page rc-page">
    <div className="nl-top"><small>{[venue.name, '本人'].filter(Boolean).join(' · ')}</small></div>
    <h1>记录</h1>
    <p className="nl-meta">回头看看，自己在慢慢变化。</p>
    {error && <p role="alert" className="nl-danger-strong">{error}</p>}

    <section aria-label="我的病历">
      <div className="nl-top"><h2>我的病历</h2>
        {groups.length > 0 && <button type="button" className="nl-link-button rc-link" onClick={onOpenAllRecords}>全部 {groups.length} 次 ›</button>}
      </div>
      {groups.length === 0 && <p className="nl-empty">还没有收到的病历。老师签字交还后会出现在这里。</p>}
      {groups.slice(0, 2).map(group => <button type="button" className="nl-card rc-record" key={group.encounterId} onClick={onOpenAllRecords}>
        <span className="nl-row-main"><strong>{groupLabel(group)}</strong><span>{venue.call || '老师'} · 已签字</span></span>
        <span className="ts-chevron">›</span>
      </button>)}
    </section>

    <section aria-label="舌象的变化">
      <div className="nl-top"><h2>舌象的变化</h2><span className="nl-meta">同一时辰对照</span></div>
      {tongues.length === 0 && <p className="nl-empty">还没有舌象记录。在“今天 → 照镜子”里拍一张。</p>}
      {tongues.length > 0 && <div className="nl-card rc-tongues">
        {tongues.map(item => <figure className={'rc-tongue' + (item.label === '今天' ? ' today' : '')} key={item.day}>
          <figcaption>{item.label}</figcaption>
          <div className="rc-tongue-fig" dangerouslySetInnerHTML={{ __html: item.record.svg }} />
          <p>{tongueFeatureShortText(item.record.features, 'color')} · {tongueFeatureShortText(item.record.features, 'coatingColor')}</p>
        </figure>)}
      </div>}
      {tongues.length > 0 && <p className="nl-quiet">特征示意 · 仅供自己对照</p>}
    </section>

    <section aria-label="坚持的趋势">
      <div className="nl-top"><h2>坚持的趋势</h2><span className="nl-meta">近四周</span></div>
      <div className="nl-card rc-trend">
        <svg viewBox="0 0 360 120" role="img" aria-label="近四周完成天数">
          <line x1="20" y1="100" x2="340" y2="100" stroke="#e3ddd1" />
          <polyline points={line} fill="none" stroke="#2f5d4a" strokeWidth="2" />
          {points.map(point => <g key={point.week.start}>
            <circle cx={point.x} cy={point.y} r="4" fill="#2f5d4a" />
            <text x={point.x} y={point.y - 10} textAnchor="middle" fontSize="12" fill="#1f2a24">{point.week.done}天</text>
            <text x={point.x} y={114} textAnchor="middle" fontSize="11" fill="#6b746c">{point.week.label}</text>
          </g>)}
        </svg>
        <p>{caption}</p>
      </div>
    </section>
  </div>
}
