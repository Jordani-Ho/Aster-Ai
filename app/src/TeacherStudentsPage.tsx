import { useEffect, useMemo, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { SendEnvelope } from './core/inbox'
import { listConsults, listStudentAdherence } from './core/inbox'
import { knownStudents } from './core/record/in-person'
import { teacherRecordsOf, type LoadedTeacherRecord } from './core/records/teacher'
import type { CarePlan } from './core/careplan'
import type { LedgerView } from './core/ledger/sync'
import { parseChainFields } from './core/ledger'
import { formatMoney } from './core/ledger/money'
import { buildStudentRows, filterStudentRows, lastVisitLabel, type StudentRow } from './teacher-students'
import { localDay } from './core/homework/schedule'
import { TeacherCarePlan } from './TeacherCarePlan'
import { PostureTool } from './PostureTool'
import { loadOwnStorefront, verifyStorefrontEvent, type Storefront } from './core/storefront'
import { loadTeacherHerbSnapshot } from './core/herbs/snapshots'
import './newui.css'

// V2-17 老师·学生（06）与一位学生（07）。
// 名单只读本机：老师认得的学生、问诊箱、签字病历、学生发来的周汇总。
// 老师端只展示学生上报的数值小结，不逐日推断打卡。
export interface TeacherStudentsPageProps {
  identity: Identity
  store: LocalStore
  llm: LlmClient | null
  send?: SendEnvelope
  ledger?: { view(teacher: string, student: string): Promise<LedgerView> } | null
  onVisit: (student: string) => void
}

interface StudentData {
  rows: StudentRow[]
  records: Record<string, LoadedTeacherRecord[]>
  venued: Storefront | null
  error: string
}

function statusClass(status: StudentRow['status']): string {
  return 'ts-badge ' + status
}

function genderAge(record: LoadedTeacherRecord | undefined): string {
  if (!record) return '资料未填'
  const { gender, age, city } = record.encounter.profile
  const parts = [gender.value === 'male' ? '男' : gender.value === 'female' ? '女' : '', age.value ? age.value + ' 岁' : '', city.value ?? '']
  return parts.filter(Boolean).join(' · ') || '资料未填'
}

function visitKind(records: readonly LoadedTeacherRecord[], index: number): string {
  return index === records.length - 1 ? '初诊' : '复诊'
}

function dateLabel(at: string | null): string {
  if (!at) return ''
  const time = Date.parse(at)
  if (!Number.isFinite(time)) return ''
  const day = new Date(time)
  return `${day.getMonth() + 1}月${day.getDate()}日`
}

export function TeacherStudentsPage({ identity, store, llm, send, ledger, onVisit }: TeacherStudentsPageProps) {
  const [data, setData] = useState<StudentData>({ rows: [], records: {}, venued: null, error: '' })
  const [search, setSearch] = useState('')
  const [recentOnly, setRecentOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const refresh = () => {
      void (async () => {
        const [people, reports, consults, own] = await Promise.all([knownStudents(store), listStudentAdherence(store), listConsults(store), loadOwnStorefront(store, identity)])
        const records: Record<string, LoadedTeacherRecord[]> = {}
        for (const student of people) records[student] = await teacherRecordsOf(store, student)
        const today = localDay(new Date())
        const rows = buildStudentRows(people.map(student => {
          const rows = records[student] ?? []
          const consult = consults.find(item => item.sender === student) ?? consults.map(item => item).find(item => item.encounter.student === student)
          const alias = rows.at(0)?.encounter.profile.alias.value ?? consult?.encounter.profile.alias.value ?? '学生 ' + student.slice(0, 4)
          const managedBy = rows.at(0)?.encounter.profile.managedBy?.value ?? consult?.encounter.profile.managedBy?.value ?? undefined
          const lastAt = [rows.at(0)?.encounter.createdAt ?? null, consult?.receivedAt ?? null].filter((value): value is string => typeof value === 'string').sort().at(-1) ?? null
          const report = reports.find(item => item.student === student) ?? null
          return { student, alias, ...(managedBy ? { managedBy } : {}), lastAt, report }
        }), today)
        if (!active) return
        setData({ rows, records, venued: own.current ? verifyStorefrontEvent(own.current, identity.publicKey)?.storefront ?? null : null, error: '' })
      })().catch(() => { if (active) setData(previous => ({ ...previous, error: '学生名单读取失败，请稍后重试。' })) })
    }
    refresh()
    window.addEventListener('aster:data-changed', refresh)
    return () => { active = false; window.removeEventListener('aster:data-changed', refresh) }
  }, [store, identity])

  const filtered = useMemo(() => filterStudentRows(data.rows, { search, recentOnly }), [data.rows, search, recentOnly])
  const recentCount = useMemo(() => data.rows.filter(row => row.recent).length, [data.rows])

  if (selected) {
    const row = data.rows.find(item => item.student === selected)
    if (!row) { setSelected(null); return null }
    return <StudentDetail identity={identity} store={store} llm={llm} send={send} ledger={ledger} row={row} records={data.records[selected] ?? []} onBack={() => setSelected(null)} onVisit={() => onVisit(selected)} venued={data.venued} />
  }

  return <div className="nl-page">
    <div className="nl-top"><small>{data.venued?.name || '我的馆'}</small><span className="nl-meta">{data.rows.length} 位</span></div>
    <h1>学生</h1>
    <label className="ts-search"><span aria-hidden="true">⌕</span>
      <input aria-label="找一位学生" placeholder="找一位学生" value={search} onChange={event => setSearch(event.target.value)} />
    </label>
    <div className="nl-tabs ts-filters" role="group" aria-label="学生筛选">
      <button type="button" aria-pressed={!recentOnly} onClick={() => setRecentOnly(false)}>全部 {data.rows.length}</button>
      <button type="button" aria-pressed={recentOnly} onClick={() => setRecentOnly(true)}>最近来过 {recentCount}</button>
    </div>
    {data.error && <p role="alert" className="nl-danger-strong">{data.error}</p>}
    {data.rows.length === 0 && <p className="nl-empty">还没有学生。在“我的馆 → 邀请学生”里请他们进来。</p>}
    {data.rows.length > 0 && filtered.length === 0 && <p className="nl-empty">没有找到这位学生。</p>}
    <ul className="ts-list">
      {filtered.map(row => <li key={row.student}>
        <button type="button" className="ts-row" onClick={() => setSelected(row.student)}>
          <span className="nl-avatar" aria-hidden="true">{row.alias.slice(0, 1)}</span>
          <span className="ts-row-main">
            <strong>{row.alias}</strong>
            <span>{row.managedBy ? `由${row.managedBy}代管 · ` : ''}{lastVisitLabel(row.lastAt)}</span>
          </span>
          {row.status !== 'unknown' && <span className={statusClass(row.status)}>{row.weekLabel}</span>}
          <span className="ts-chevron" aria-hidden="true">›</span>
        </button>
      </li>)}
    </ul>
    <p className="nl-help">点一位学生，看病历、方案和坚持情况。</p>
  </div>
}

function StudentDetail({ identity, store, llm, send, ledger, row, records, onBack, onVisit, venued }: {
  identity: Identity
  store: LocalStore
  llm: LlmClient | null
  send?: SendEnvelope
  ledger?: { view(teacher: string, student: string): Promise<LedgerView> } | null
  row: StudentRow
  records: LoadedTeacherRecord[]
  onBack: () => void
  onVisit: () => void
  venued: Storefront | null
}) {
  const latest = records.at(0)
  const [plan, setPlan] = useState<CarePlan | null>(null)
  const [showPlan, setShowPlan] = useState(false)
  const [showAllRecords, setShowAllRecords] = useState(false)
  const [postureOpen, setPostureOpen] = useState(false)
  const [balance, setBalance] = useState<{ text: string; currency: string } | null>(null)
  const [herbSnapshots, setHerbSnapshots] = useState<Record<string, import('./core/herbs').SharedHomeHerb[] | undefined>>({})
  const report = row.report
  const shownRecords = showAllRecords ? records : records.slice(0, 2)

  useEffect(() => {
    let active = true
    void store.get('care-plan-snapshot', row.student).then(value => {
      if (!active || !value || typeof value !== 'object') return
      const candidate = value as unknown as CarePlan
      if (typeof candidate.constitution === 'string' && Array.isArray(candidate.points)) setPlan(candidate)
    }).catch(() => {})
    return () => { active = false }
  }, [store, row.student])

  useEffect(() => {
    let active = true
    void Promise.all(records.map(async record => [record.encounter.id, await loadTeacherHerbSnapshot(store, record.encounter.id)] as const))
      .then(rows => { if (active) setHerbSnapshots(Object.fromEntries(rows)) })
      .catch(() => { if (active) setHerbSnapshots({}) })
    return () => { active = false }
  }, [store, records])

  useEffect(() => {
    let active = true
    if (!ledger) return
    void ledger.view(identity.publicKey, row.student).then(view => {
      if (!active || view.balance === null) return
      const currency = view.ledger.events.length ? parseChainFields(view.ledger.events[0]).currency : ''
      setBalance({ text: formatMoney(view.balance, currency), currency })
    }).catch(() => {})
    return () => { active = false }
  }, [ledger, identity.publicKey, row.student])

  return <div className="nl-detail">
    {postureOpen ? <PostureTool identity={identity} store={store} student={row.student} onClose={() => setPostureOpen(false)} /> : <>
    <header className="nl-flow-head">
      <button type="button" className="nl-back" aria-label="返回" onClick={onBack}>‹</button>
      <div><h1>{row.alias}</h1><small>{genderAge(latest)}</small></div>
    </header>
    <div className="nl-flow-body nl-detail-body">
      <section className="ts-plan-card" aria-label="当前方案">
        <div className="ts-plan-head"><h2>当前方案</h2><span className={plan ? 'ts-badge ok' : 'ts-badge unknown'}>{plan ? '老师已签字' : '还没有方案'}</span></div>
        {plan
          ? <>
            <strong>{plan.points[0] ?? plan.constitution}</strong>
            <p className="nl-quiet">{dateLabel(plan.updatedAt)}更新 · {venued?.displayName || '老师'}</p>
            <button type="button" className="nl-link-button ts-plan-more" onClick={() => setShowPlan(value => !value)}>{showPlan ? '收起完整方案' : '点开看完整方案 ›'}</button>
            {showPlan && <div className="nl-quiet">
              <p>体质：{plan.constitution}</p>
              <ul>{plan.points.map((point, index) => <li key={index}>{point}</li>)}</ul>
              {plan.avoid.length > 0 && <p>注意避开：{plan.avoid.join('、')}</p>}
            </div>}
          </>
          : <>
            <p className="nl-quiet">还没有给这位学生签过调养方案。</p>
            <details className="nl-section"><summary>现在定制调养方案</summary>
              <TeacherCarePlan identity={identity} store={store} student={row.student} llm={llm} send={send} />
            </details>
          </>}
      </section>

      <section aria-label="体态记录">
        <div className="nl-top"><h2>体态</h2></div>
        <div className="nl-card">
          <p className="nl-quiet">当面看学生走路、坐下、弯腰：采集骨架、按您的公式算指标、标注失衡、看长期趋势。照片/视频识别完当场清掉。</p>
          <button type="button" className="nl-primary" onClick={() => setPostureOpen(true)}>打开体态工具</button>
        </div>
      </section>

      <section aria-label="坚持情况">
        <div className="nl-top"><h2>坚持情况</h2><span className="nl-meta">{report ? `本周 ${report.practiceDays}/${Math.max(report.scheduled, report.practiceDays)} 天` : '本周还没有小结'}</span></div>
        <div className="nl-card">
          {report
            ? <>
              <div className="ts-week" aria-label="本周完成天数示意">
                {Array.from({ length: 7 }, (_, index) => <span key={index} className={index < report.practiceDays ? 'ts-week-dot done' : 'ts-week-dot'} aria-hidden="true">{index < report.practiceDays ? '✓' : ''}</span>)}
              </div>
              <p>本周完成 {report.practiceDays} 天{report.streak > 0 ? ` · 已连续 ${report.streak} 天` : ''}</p>
            </>
            : <p className="nl-quiet">学生发来坚持率小结后，这里会显示本周完成情况。</p>}
        </div>
      </section>

      <section aria-label="历次病历">
        <div className="nl-top"><h2>历次病历</h2>
          {records.length > 2 && <button type="button" className="nl-link-button ts-all" onClick={() => setShowAllRecords(value => !value)}>全部 {records.length} 次 ›</button>}
        </div>
        {records.length === 0 && <p className="nl-empty">还没有签字病历。</p>}
        {records.length > 0 && <div className="nl-card ts-records">
          {shownRecords.map(record => {
            const snapshot = herbSnapshots[record.encounter.id]
            return <div className="ts-record" key={record.eventId}>
              <span className="ts-record-dot" aria-hidden="true" />
              <div>
                <strong>{dateLabel(record.encounter.createdAt)} · {visitKind(records, records.indexOf(record))}</strong>
                <p className="nl-quiet">已签字 · {venued?.displayName || '老师'}老师</p>
                {snapshot?.length ? <details className="nl-section"><summary>这次问诊的家中药材快照</summary>
                  <ul>{snapshot.map(item => <li key={item.name}>{item.name} · {'quantity' in item ? `${item.quantity}${item.unit}` : item.status}</li>)}</ul>
                </details> : null}
              </div>
            </div>
          })}
        </div>}
      </section>

      <section aria-label="钱账">
        <div className="ts-balance-row">
          <div><strong>钱账</strong><p className="nl-quiet">在您这里的余额</p></div>
          <strong className="ts-balance">{balance ? balance.text : '—'}</strong>
        </div>
      </section>
      {!balance && <p className="nl-quiet">还没有记过账，或账本尚未同步。</p>}
    </div>
    <footer className="ts-detail-foot">
      <button type="button" className="nl-primary" onClick={onVisit}>＋ 开始面诊</button>
    </footer>
    </>}
  </div>
}
