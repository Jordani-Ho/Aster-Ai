import { useEffect, useMemo, useRef, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { Encounter, Homework } from './core/record/types'
import {
  POSTURE_ACTIONS, computeMetrics, metricDeltas, postureTrends, unbalancedCounts,
  type PostureFrame, type PostureGuideKind, type PostureMark, type PostureMetric,
  type PostureMetricValue, type PosturePointName, type PostureRecord, type PostureSegment,
} from '../../domain/tcm/posture'
import {
  analyzePostureFile, deletePostureDraft, loadPostureMetrics,
  newPostureRecord, newPostureSegment, postureHomework, resolveDetector, savePostureDraft,
  studentPostureRecords, type PoseDetector, type SignedPostureRecord,
} from './core/posture'
import { PostureSkeleton } from './PostureSkeleton'
import './newui.css'

const ACTIONS = [...POSTURE_ACTIONS, '自定义']
function fmt(value: number | null, unit: string): string { return value === null ? '—' : `${value}${unit}` }
function clock(at: string): string { const date = new Date(at); return `${date.getMonth() + 1}月${date.getDate()}日` }

// V2-30 体态工具：老师当场采集/导入 → 多段（做动作前/后）→ 指标 → 标注与拖点 → 存本机 / 随面诊签字。
export function PostureTool({ identity, store, student, encounter, onClose, onChangePostures, onAddHomework }: {
  identity: Identity
  store: LocalStore
  student: string
  encounter?: Encounter | null
  onClose?: () => void
  onChangePostures?: (postures: PostureRecord[]) => void
  onAddHomework?: (homework: Homework) => void
}) {
  const [tab, setTab] = useState<'capture' | 'records' | 'trends'>('capture')
  const [metrics, setMetrics] = useState<PostureMetric[]>([])
  const [segments, setSegments] = useState<PostureSegment[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [selectedPoint, setSelectedPoint] = useState<PosturePointName | null>(null)
  const [rule, setRule] = useState('')
  const [view, setView] = useState<'front' | 'side'>('front')
  const [action, setAction] = useState<string>('站立')
  const [phase, setPhase] = useState<'before' | 'after'>('before')
  const [note, setNote] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [records, setRecords] = useState<SignedPostureRecord[]>([])
  const detector = useRef<PoseDetector | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const selected = segments.find(item => item.id === selectedId) ?? segments.at(-1)!
  const signedCount = encounter?.postures?.length ?? 0

  const refresh = () => { void loadPostureMetrics(store).then(setMetrics).catch(() => {}); void studentPostureRecords(store, student).then(setRecords).catch(() => {}) }
  useEffect(refresh, [store, student])
  useEffect(() => () => { detector.current?.close?.() }, [])

  const addFrame = (frame: PostureFrame) => {
    const segment = newPostureSegment(frame, action === '自定义' ? (rule.trim() || '站立') : action, phase, note)
    setSegments(current => [...current, segment]); setSelectedId(segment.id); setStatus('识别完成：照片/视频已从应用内清掉，只留关键点。')
  }

  const analyze = async (file: File) => {
    setBusy(true); setError(''); setStatus('')
    try {
      const engine = detector.current ?? (detector.current = await resolveDetector())
      addFrame(await analyzePostureFile(file, engine, { view }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '识别没有完成，请重拍或改用导入。')
    } finally { setBusy(false) }
  }

  const updateSelected = (patch: Partial<PostureSegment>) => setSegments(current => current.map(item => item.id === selected?.id ? { ...item, ...patch } : item))
  const markPoint = () => {
    if (!selected || !selectedPoint) { setError('先在骨架上点一个关节。'); return }
    const reason = rule.trim()
    if (reason === '') { setError('写一句原因再标失衡。'); return }
    const marks = [...(selected.marks ?? []).filter(mark => mark.point !== selectedPoint), { point: selectedPoint, reason: reason.slice(0, 200), source: 'teacher' as const }]
    updateSelected({ marks }); setRule(''); setStatus(`已标“失衡”：${selectedPoint}。`)
  }
  const addGuide = (kind: PostureGuideKind) => {
    if (!selected) return
    const guides = [...(selected.guides ?? [])]
    if (!guides.some(guide => guide.kind === kind)) guides.push({ kind, source: 'teacher' })
    updateSelected({ guides })
  }
  const dragPoint = (point: PosturePointName, x: number, y: number) => {
    if (!selected) return
    updateSelected({ overrides: { ...(selected.overrides ?? {}), [point]: { x, y, source: 'teacher' } } })
  }
  const save = async () => {
    if (segments.length === 0) { setError('先采集或导入一段骨架。'); return }
    setBusy(true); setError('')
    try {
      const record = newPostureRecord(identity, student, segments, metrics)
      await savePostureDraft(store, record)
      if (encounter && onChangePostures) onChangePostures([...(encounter.postures ?? []), record])
      setSegments([]); setSelectedId(''); setStatus('体态记录已保存到本机' + (encounter ? '，签字时一并保存。' : '。在面诊草稿里保存会随签字进病历。'))
      refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存没有完成，请重试。') } finally { setBusy(false) }
  }
  const removeDraft = async (record: PostureRecord) => { await deletePostureDraft(store, record.id); refresh() }

  const values = useMemo(() => selected ? computeMetrics(selected, metrics) : [], [selected, metrics])
  const compare = useMemo(() => {
    const signed = records.map(item => item.record)
    const last = signed.at(-1), previous = signed.at(-2)
    if (!last || !previous) return null
    const at = (record: PostureRecord) => { const segment = record.segments.find(item => item.phase === 'before') ?? record.segments[0]; return record.values[segment.id] ?? computeMetrics(segment, record.metrics) }
    return metricDeltas(at(previous), at(last))
  }, [records])
  const pairSource = segments.length > 0 ? segments : (records.at(-1)?.record.segments ?? [])
  const pairAction = selected?.action ?? pairSource[0]?.action ?? ''
  const before = pairSource.find(item => item.action === pairAction && item.phase === 'before')
  const after = pairSource.find(item => item.action === pairAction && item.phase === 'after')
  const pairs = before && after ? { before, after } : null
  const trends = useMemo(() => postureTrends(records.map(item => item.record)), [records])
  const counts = useMemo(() => unbalancedCounts(records.map(item => item.record)), [records])

  const head = <header className="nl-flow-head"><button type="button" className="nl-back" aria-label="返回" onClick={() => onClose?.()}>‹</button><div><h1>体态工具</h1><small>只把人变成骨架、按老师定的公式算数；不判断</small></div></header>
  const tabs = <div className="nl-tabs" role="group" aria-label="体态工具页面"><button type="button" aria-pressed={tab === 'capture'} onClick={() => setTab('capture')}>采集</button><button type="button" aria-pressed={tab === 'records'} onClick={() => setTab('records')}>记录对比</button><button type="button" aria-pressed={tab === 'trends'} onClick={() => setTab('trends')}>趋势</button></div>

  return <div className="nl-shell"><main className="nl-page">
    {head}{tabs}
    {error && <p role="alert" className="nl-danger-strong">{error}</p>}
    {status && <p role="status" className="nl-quiet">{status}</p>}

    {tab === 'capture' && <>
      <section aria-label="采集体态" className="nl-card">
        <div className="nl-top"><h2>采集 / 导入</h2><span className="nl-meta">照片/视频只在这里用，识别完当场清掉</span></div>
        <div className="nl-tabs" role="group" aria-label="视角"><button type="button" aria-pressed={view === 'front'} onClick={() => setView('front')}>正面</button><button type="button" aria-pressed={view === 'side'} onClick={() => setView('side')}>侧面</button></div>
        <label>动作<select aria-label="动作" value={action} onChange={event => { setAction(event.target.value) }}>{ACTIONS.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
        {action === '自定义' && <label>自定义动作<input value={rule} maxLength={30} placeholder="例如：抬左腿" onChange={event => setRule(event.target.value)} /></label>}
        <label>阶段<select aria-label="阶段" value={phase} onChange={event => setPhase(event.target.value as 'before' | 'after')}><option value="before">做动作前</option><option value="after">做动作后</option></select></label>
        <label>这一段学生当时的感觉（可空）<input value={note} maxLength={200} onChange={event => setNote(event.target.value)} /></label>
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/webm,video/quicktime" hidden aria-label="拍摄或选择体态照片/视频" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void analyze(file) }} />
        <button type="button" className="nl-primary" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? '正在识别…' : '拍一张 / 选照片或视频'}</button>
        <p className="nl-quiet">也可以导入 FreeMoCap 导出文件：<ImportButton disabled={busy} onPick={async file => {
          setBusy(true); setError('')
          try {
            const { parseFreeMoCapCsv, parseFreeMoCapNpy } = await import('./core/posture')
            const data = file.name.toLowerCase().endsWith('.npy') ? parseFreeMoCapNpy(new Uint8Array(await file.arrayBuffer()), { view }) : parseFreeMoCapCsv(await file.text(), { view })
            addFrame(data)
          } catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败：文件格式不对。') } finally { setBusy(false) }
        }} /></p>
      </section>
      {segments.length > 0 && <section aria-label="这一段的骨架与指标" className="nl-card">
        <div className="nl-top"><h2>这一段的骨架</h2><span className="nl-meta">{segments.length} 段 · 点关节可标失衡 / 拖动可改点</span></div>
        <div className="nl-tabs" role="group" aria-label="选择段落">{segments.map(item => <button key={item.id} type="button" aria-pressed={selected?.id === item.id} onClick={() => { setSelectedId(item.id); setSelectedPoint(null) }}>{item.action}·{item.phase === 'before' ? '前' : '后'}</button>)}</div>
        {selected && <>
          <PostureSkeleton frame={selected.frame} marks={selected.marks} guides={selected.guides} overrides={selected.overrides} editable height={190} onDrag={dragPoint} onSelectPoint={setSelectedPoint} />
          <p className="nl-quiet">{selected.action} · {selected.phase === 'before' ? '做动作前' : '做动作后'}{selected.note ? ' · ' + selected.note : ''}</p>
          <div className="nl-tabs" role="group" aria-label="标注工具">
            <button type="button" onClick={() => { if (selectedPoint) { setRule(rule || '') } else setError('先在骨架上点一个关节。') }}>点关节：{selectedPoint ?? '未选'}</button>
            <button type="button" onClick={markPoint}>标失衡</button>
            <button type="button" onClick={() => addGuide('shoulder_line')}>画两肩连线</button>
            <button type="button" onClick={() => addGuide('spine_midline')}>画脊柱中线</button>
          </div>
          <label>失衡原因<input value={rule} maxLength={200} placeholder="例如：左肩明显高，长期单侧背包" onChange={event => setRule(event.target.value)} /></label>
          {(selected.overrides && Object.keys(selected.overrides).length > 0) && <p className="nl-quiet">老师改过：{Object.keys(selected.overrides).join('、')}（指标按改后坐标重算）</p>}
          {(selected.marks ?? []).length > 0 && <ul className="nl-list">{(selected.marks ?? []).map(mark => <li key={mark.point}>{mark.point}：{mark.reason}（来源 teacher）</li>)}</ul>}
          <table aria-label="这一段指标"><thead><tr><th>指标</th><th>值</th><th>说明</th></tr></thead><tbody>{values.map(value => <tr key={value.id}><td>{value.name}</td><td>{value.status === 'ok' ? fmt(value.value, value.unit) : '这次算不出'}</td><td className="nl-quiet">{value.reason ?? ''}</td></tr>)}</tbody></table>
          {onAddHomework && <button type="button" className="op-link-button" onClick={() => { onAddHomework(postureHomework(selected.action)); setStatus('已加进这次面诊的作业草稿。') }}>把“{selected.action}”一键加进作业</button>}
        </>}
      </section>}
      {segments.length > 0 && <div className="nl-tabs" role="group" aria-label="保存体态记录"><button type="button" className="nl-primary" disabled={busy} onClick={() => void save()}>保存这段体态记录</button></div>}
      {encounter && signedCount > 0 && <p className="nl-quiet">这次面诊已带 {signedCount} 条体态记录，签字时一起保存。</p>}
    </>}

    {tab === 'records' && <>
      {compare && <section aria-label="和上次比" className="nl-card"><div className="nl-top"><h2>每条指标：上次 → 这次</h2></div>
        <table aria-label="和上次比"><thead><tr><th>指标</th><th>上次</th><th>这次</th><th>变化</th></tr></thead><tbody>{compare.map(item => <tr key={item.id}><td>{item.name}</td><td>{fmt(item.before, item.unit)}</td><td>{fmt(item.after, item.unit)}</td><td>{item.delta === null ? '这次算不出' : (item.delta > 0 ? '+' : '') + item.delta + item.unit}</td></tr>)}</tbody></table></section>}
      {pairs && <section aria-label="做动作前后对比" className="nl-card"><div className="nl-top"><h2>{pairs.before.action}：做动作前 / 后</h2></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[pairs.before, pairs.after].map(segment => <div key={segment.id}><PostureSkeleton frame={segment.frame} marks={segment.marks} guides={segment.guides} overrides={segment.overrides} height={150} /><p className="nl-quiet">{segment.phase === 'before' ? '做动作前' : '做动作后'}</p></div>)}
        </div>
        <table aria-label="前后指标变化"><thead><tr><th>指标</th><th>前</th><th>后</th><th>变化</th></tr></thead><tbody>{metricDeltas(computeMetrics(pairs.before, metrics), computeMetrics(pairs.after, metrics)).map(item => <tr key={item.id}><td>{item.name}</td><td>{fmt(item.before, item.unit)}</td><td>{fmt(item.after, item.unit)}</td><td>{item.delta === null ? '这次算不出' : (item.delta > 0 ? '+' : '') + item.delta + item.unit}</td></tr>)}</tbody></table>
      </section>}
      <section aria-label="体态记录列表" className="nl-card"><div className="nl-top"><h2>这位学生的体态记录</h2><span className="nl-meta">{records.length} 条</span></div>
        {records.length === 0 && <p className="nl-empty">还没有体态记录。</p>}
        <ul className="nl-list">{records.map(item => <li key={item.record.id} className="nl-row"><span className="nl-row-main"><strong>{clock(item.record.at)} · {item.record.segments.length} 段</strong><span>{item.record.segments.map(segment => `${segment.action}·${segment.phase === 'before' ? '前' : '后'}`).join(' / ')}</span></span>{item.encounterId === '' ? <button type="button" onClick={() => void removeDraft(item.record)}>删除草稿</button> : <span className="nl-pill muted">已随病历</span>}</li>)}</ul>
      </section>
    </>}

    {tab === 'trends' && <section aria-label="体态长期趋势" className="nl-card"><div className="nl-top"><h2>每条指标的走势</h2><span className="nl-meta">{records.length} 条记录</span></div>
      {Object.entries(trends).map(([id, trend]) => <div key={id} className="nl-homework-item"><strong>{trend.name}（{trend.unit}）</strong><p className="nl-quiet">{trend.points.map(point => point.value === null ? '—' : point.value).join(' → ')}</p></div>)}
      <div className="nl-top"><h2>标过“失衡”的节点</h2></div>
      {Object.entries(counts).length === 0 && <p className="nl-empty">还没有标过失衡。</p>}
      <ul className="nl-list">{Object.entries(counts).map(([point, entry]) => <li key={point}>{point}：{entry.count} 次，最近 {clock(entry.lastAt)}（{entry.reason}）</li>)}</ul>
    </section>}
  </main></div>
}

function ImportButton({ disabled, onPick }: { disabled: boolean; onPick: (file: File) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <input ref={input} type="file" accept=".csv,.npy" hidden aria-label="导入 FreeMoCap 导出文件" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void onPick(file) }} />
    <button type="button" disabled={disabled} onClick={() => input.current?.click()}>导入骨架</button>
  </>
}

// 签字/学生端只读：骨架 +（可选）指标 + 标注（老师写的判断随病历保存，来源 teacher）。
// V2-32：学生端只看自己拍的骨架，不显示数值、不下结论（showValues=false）。
export function PostureSummary({ postures, title = '体态记录', showValues = true }: { postures: PostureRecord[] | undefined; title?: string; showValues?: boolean }) {
  if (!postures || postures.length === 0) return null
  const hasStudent = postures.some(record => record.capturedBy === 'student')
  return <section aria-label={title} className="nl-card"><div className="nl-top"><h2>{title}</h2><span className="nl-meta">{postures.length} 条 · {hasStudent ? '含学生在家拍的' : '老师标注'}</span></div>
    {postures.map(record => <div key={record.id}>
      <p className="nl-quiet">{clock(record.at)} · {record.segments.length} 段 · {record.capturedBy === 'student' ? '学生在家拍' : '老师当面看'}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>{record.segments.map(segment => <div key={segment.id}>
        <PostureSkeleton frame={segment.frame} marks={segment.marks} guides={segment.guides} overrides={segment.overrides} height={120} />
        <p className="nl-quiet">{(record.capturedBy === 'student' ? (segment.frame.view === 'video' ? '走路视频' : segment.frame.view === 'front' ? '正面' : '侧面') : segment.action)}·{segment.phase === 'before' ? '前' : '后'}{segment.note ? '：' + segment.note : ''}</p>
        {showValues && <ul className="nl-list">{(record.values[segment.id] ?? []).map((value: PostureMetricValue) => <li key={value.id}>{value.name}：{value.status === 'ok' ? fmt(value.value, value.unit) : '这次算不出'}</li>)}</ul>}
        {(segment.marks ?? []).map((mark: PostureMark) => <p key={mark.point} className="nl-quiet">失衡：{mark.point}（{mark.reason}）</p>)}
      </div>)}</div>
    </div>)}
  </section>
}