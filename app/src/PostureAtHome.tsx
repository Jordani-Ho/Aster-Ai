import { useRef, useState } from 'react'
import {
  computeMetrics, type PostureFrame, type PostureMetric, type PostureRecord,
} from '../../domain/tcm/posture'
import { analyzePostureFile, resolveDetector, type PoseDetector } from './core/posture'
import { PostureSkeleton } from './PostureSkeleton'
import './newui.css'
import './student.css'

// V2-32：学生在家拍体态——问诊卡片页与舌象并列的一块（可空）。
// 识别管线、照片规范化、清理逻辑与骨架图全部复用 V2-30；学生端只留关键点，不算指标、不下结论。
const VIEW_LABELS = { front: '正面', side: '侧面', video: '走路视频' } as const

function fmt(value: number | null, unit: string): string { return value === null ? '—' : `${value}${unit}` }

export function PostureAtHome({ posture, disabled = false, onBusyChange, onFrame, onRemove, onNote }: {
  posture?: PostureRecord
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onFrame: (frame: PostureFrame) => void
  onRemove: (segmentId: string) => void
  onNote: (segmentId: string, note: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const detector = useRef<PoseDetector | null>(null)
  const pending = useRef<{ view: 'front' | 'side'; video: boolean }>({ view: 'front', video: false })
  const input = useRef<HTMLInputElement>(null)

  const analyze = async (file: File) => {
    setBusy(true); onBusyChange?.(true); setError(''); setStatus('')
    try {
      const engine = detector.current ?? (detector.current = await resolveDetector())
      const frame = await analyzePostureFile(file, engine, { view: pending.current.view })
      if (pending.current.video && frame.view !== 'video') throw new Error('这里要拍一段 15 秒以内的走路视频；照片请用“拍正面 / 拍侧面”。')
      if (!pending.current.video && frame.view === 'video') throw new Error('这是视频：请用“拍走路视频”。')
      onFrame(frame)
      setStatus('识别好了：只留下骨架，照片已经从手机里清掉。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '识别没有完成，请重拍。')
    } finally { setBusy(false); onBusyChange?.(false) }
  }
  const pick = (view: 'front' | 'side', video = false) => { pending.current = { view, video }; input.current?.click() }
  const segments = posture?.segments ?? []

  return <section aria-label="这次的体态" className="nl-card cf-posture">
    <div className="nl-top"><strong>这次的体态（可空）</strong><span className="nl-meta">只留骨架，照片当场清掉</span></div>
    <p className="nl-quiet">拍正面、侧面各一张，或一段 15 秒以内的走路视频；不想拍也能直接发。</p>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/webm,video/quicktime" hidden aria-label="拍摄或选择体态照片/视频"
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void analyze(file) }} />
    <div className="nl-tabs" role="group" aria-label="拍体态">
      <button type="button" disabled={disabled || busy} onClick={() => pick('front')}>拍正面</button>
      <button type="button" disabled={disabled || busy} onClick={() => pick('side')}>拍侧面</button>
      <button type="button" disabled={disabled || busy} onClick={() => pick('side', true)}>拍走路视频</button>
    </div>
    {busy && <p className="nl-quiet" role="status">正在把照片变成骨架…</p>}
    {error && <p role="alert" className="nl-danger-strong">{error}</p>}
    {status && <p role="status" className="nl-quiet">{status}</p>}
    {segments.length === 0 && <p className="nl-empty">还没拍。不拍也能继续发问诊。</p>}
    {segments.map((segment, index) => <div key={segment.id} className="cf-posture-segment">
      <PostureSkeleton frame={segment.frame} height={130} />
      <p className="nl-quiet">{VIEW_LABELS[segment.frame.view]}{segment.note ? ' · ' + segment.note : ''}</p>
      <label>这一段的感觉（可空）
        <input aria-label={`第 ${index + 1} 段的感觉`} value={segment.note ?? ''} maxLength={200} disabled={disabled || busy}
          onChange={event => onNote(segment.id, event.target.value)} />
      </label>
      <button type="button" className="op-link-button" disabled={disabled || busy} onClick={() => onRemove(segment.id)}>删掉这一段</button>
    </div>)}
  </section>
}

// 老师端远程核对：学生拍的骨架 + 老师自己 settings/posture-metrics 的指标值（学生端从来不带数值）。
export function StudentPostureReview({ postures, metrics, alias }: { postures?: PostureRecord[]; metrics: PostureMetric[]; alias?: string }) {
  if (!postures || postures.length === 0) return null
  return <section aria-label="学生自己拍的体态" className="nl-card">
    <div className="nl-top"><h2>学生自己拍的体态</h2><span className="nl-meta">只有骨架；指标按您的公式算</span></div>
    <p className="nl-quiet">照片/视频在学生手机上识别完就清掉了，这里只有关键点{alias ? `；这位是 ${alias}` : ''}。</p>
    {metrics.length === 0 && <p className="nl-empty">还没有体态指标：到“我的馆 → 模板 → 体态指标”加一条，这里就会算。</p>}
    {postures.map(record => <div key={record.id}>
      <p className="nl-quiet">{new Date(record.at).toLocaleString()} · {record.segments.length} 段{record.note ? ' · ' + record.note : ''}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        {record.segments.map(segment => {
          const values = computeMetrics(segment, metrics)
          return <div key={segment.id}>
            <PostureSkeleton frame={segment.frame} height={150} />
            <p className="nl-quiet">{VIEW_LABELS[segment.frame.view]}{segment.note ? ' · ' + segment.note : ''}</p>
            <ul className="nl-list" aria-label="学生体态指标">
              {values.map(value => <li key={value.id}>{value.name}：{value.status === 'ok' ? fmt(value.value, value.unit) : '这次算不出'}</li>)}
            </ul>
          </div>
        })}
      </div>
    </div>)}
  </section>
}
