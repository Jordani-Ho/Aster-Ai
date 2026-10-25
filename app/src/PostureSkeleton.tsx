import { useRef } from 'react'
import {
  SKELETON_EDGES, LOW_VISIBILITY, type PostureFrame, type PostureGuide, type PostureMark,
  type PostureOverride, type PosturePointName,
} from '../../domain/tcm/posture'

// 骨架示意图：只有线条与点，认不出是谁；老师可拖动点改坐标（标记“老师改过”）。
export function PostureSkeleton({ frame, marks = [], guides = [], overrides = {}, editable = false, height = 150, onDrag, onSelectPoint }: {
  frame: PostureFrame
  marks?: PostureMark[]
  guides?: PostureGuide[]
  overrides?: Partial<Record<PosturePointName, PostureOverride>>
  editable?: boolean
  height?: number
  onDrag?: (point: PosturePointName, x: number, y: number) => void
  onSelectPoint?: (point: PosturePointName) => void
}) {
  const svg = useRef<SVGSVGElement>(null)
  const dragging = useRef<PosturePointName | null>(null)
  const points = { ...frame.points, ...Object.fromEntries(Object.entries(overrides).map(([name, value]) => [name, { x: value!.x, y: value!.y }])) } as PostureFrame['points']
  const marked = new Set(marks.map(mark => mark.point))
  const changed = new Set(Object.keys(overrides) as PosturePointName[])
  const toUnit = (event: React.PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    return { x, y }
  }
  return <svg ref={svg} viewBox="0 0 100 100" role="img" aria-label={'骨架示意图' + (editable ? '（可拖点）' : '')} style={{ width: '100%', maxWidth: 260, height, background: '#f7f5ee', borderRadius: 14, touchAction: 'none', display: 'block', margin: '0 auto' }}
    onPointerMove={event => { if (!dragging.current || !onDrag) return; const { x, y } = toUnit(event); onDrag(dragging.current, x, y) }}
    onPointerUp={() => { dragging.current = null }} onPointerLeave={() => { dragging.current = null }}>
    {guides.map(guide => {
      if (guide.kind === 'spine_midline') {
        const xs = (['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'] as PosturePointName[]).filter(name => points[name]).map(name => points[name]!.x)
        if (xs.length < 2) return null
        const x = (xs.reduce((sum, value) => sum + value, 0) / xs.length) * 100
        return <line key={guide.kind} x1={x} y1={0} x2={x} y2={100} stroke="#8a6a1f" strokeWidth={0.7} strokeDasharray="2 1.6" />
      }
      const pair = guide.kind === 'shoulder_line' ? ['left_shoulder', 'right_shoulder'] : ['left_hip', 'right_hip']
      const a = points[pair[0] as PosturePointName], b = points[pair[1] as PosturePointName]
      if (!a || !b) return null
      const extension = 0.12
      const dx = b.x - a.x, dy = b.y - a.y
      return <line key={guide.kind} x1={(a.x - dx * extension) * 100} y1={(a.y - dy * extension) * 100} x2={(b.x + dx * extension) * 100} y2={(b.y + dy * extension) * 100} stroke="#8a6a1f" strokeWidth={0.7} strokeDasharray="2 1.6" />
    })}
    {SKELETON_EDGES.map(([from, to]) => {
      const a = points[from], b = points[to]
      if (!a || !b) return null
      return <line key={from + to} x1={a.x * 100} y1={a.y * 100} x2={b.x * 100} y2={b.y * 100} stroke="#2f5d4a" strokeWidth={1.1} strokeLinecap="round" />
    })}
    {(Object.entries(points) as [PosturePointName, { x: number; y: number; visibility?: number }][]).map(([name, point]) => {
      if (!point) return null
      const invisible = (point.visibility ?? 1) < LOW_VISIBILITY
      const primary = ['nose', 'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'].includes(name)
      if (!primary && !marked.has(name)) return null
      const radius = marked.has(name) ? 2.4 : 1.5
      return <circle key={name} cx={point.x * 100} cy={point.y * 100} r={radius}
        fill={marked.has(name) ? '#a33a2b' : changed.has(name) ? '#8a6a1f' : invisible ? '#fff' : '#2f5d4a'}
        stroke={invisible ? '#8a8f88' : '#fff'} strokeWidth={0.5} strokeDasharray={invisible ? '1 0.8' : undefined}
        style={editable ? { cursor: 'grab' } : undefined}
        onClick={editable && onSelectPoint ? () => onSelectPoint(name) : undefined}
        onPointerDown={editable ? event => { dragging.current = name; (event.target as Element).setPointerCapture?.(event.pointerId) } : undefined}>
        <title>{name}{invisible ? '（看不清）' : ''}{changed.has(name) ? '（老师改过）' : ''}{marked.has(name) ? '（失衡）' : ''}</title>
      </circle>
    })}
  </svg>
}
