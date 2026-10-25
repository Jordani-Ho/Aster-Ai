// V2-30 体态（B 类，已批）：只把“人变成骨架 + 按老师定的公式算数”，不下结论。
// 坐标口径：0–1 归一化，原点左上、y 向下；二维公式只用 x/y；3D 导入投到二维后同样归一化，原始 z 另存。
export const POSTURE_POINTS = [
  'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear', 'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_pinky', 'right_pinky', 'left_index', 'right_index', 'left_thumb', 'right_thumb',
  'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
  'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index',
] as const
export type PosturePointName = (typeof POSTURE_POINTS)[number]

// 画骨架用：只连身体主干，不连手指/脸。
export const SKELETON_EDGES: [PosturePointName, PosturePointName][] = [
  ['left_shoulder', 'right_shoulder'], ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'], ['left_ankle', 'left_foot_index'],
  ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'], ['right_ankle', 'right_foot_index'],
  ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
]
export const GUIDE_POINTS: Record<PostureGuideKind, [PosturePointName, PosturePointName] | 'midline'> = {
  shoulder_line: ['left_shoulder', 'right_shoulder'],
  hip_line: ['left_hip', 'right_hip'],
  spine_midline: 'midline',
}

export type PostureView = 'front' | 'side' | 'video'
export type PostureSource = 'phone' | 'studio'
export type PosturePhase = 'before' | 'after'
export type PostureGuideKind = 'shoulder_line' | 'hip_line' | 'spine_midline'
export const POSTURE_ACTIONS = ['走路', '坐下', '弯腰', '站立'] as const
export const LOW_VISIBILITY = 0.5

export interface PosturePoint { x: number; y: number; z?: number; visibility?: number }
export interface PostureFrame {
  source: PostureSource
  view: PostureView
  at: string
  width: number
  height: number
  points: Partial<Record<PosturePointName, PosturePoint>>
}
export interface PostureMark { point: PosturePointName; reason: string; source: 'teacher' }
export interface PostureGuide { kind: PostureGuideKind; source: 'teacher' }
export interface PostureOverride { x: number; y: number; source: 'teacher' }
export interface PostureSegment {
  id: string
  action: string
  phase: PosturePhase
  note?: string
  frame: PostureFrame
  marks?: PostureMark[]
  guides?: PostureGuide[]
  overrides?: Partial<Record<PosturePointName, PostureOverride>>
}
export interface PostureMetric { id: string; name: string; formula: string; unit: string }
export type PostureMetricStatus = 'ok' | 'unavailable'
export interface PostureMetricValue {
  id: string
  name: string
  unit: string
  status: PostureMetricStatus
  value: number | null
  reason?: string
}
export interface PostureRecord {
  id: string                 // 32 位十六进制
  student: string
  teacher: string
  at: string
  segments: PostureSegment[]
  metrics: PostureMetric[]   // 保存时的指标快照（老师后来改指标不影响旧记录）
  values: Record<string, PostureMetricValue[]> // segmentId → 每条指标
  note?: string
  /** V2-32：谁拍的。学生在家拍的记录随远程问诊包走，学生端不算指标；旧记录没有这个字段按老师端处理。 */
  capturedBy?: 'student' | 'teacher'
}

// ---------- 公式白名单：两点高低差 / 两点距离 / 三点夹角 / 左右对称差 / 偏离中线 ----------
export const POSTURE_FORMULA_FUNCTIONS = ['heightDiff', 'distance', 'angle', 'symmetry', 'midlineOffset'] as const

export class PostureFormulaError extends Error {
  constructor(message: string) { super(message); this.name = 'PostureFormulaError' }
}

type Tok = { kind: 'num' | 'name' | 'op'; text: string; at: number }
function tokenize(formula: string): Tok[] {
  const out: Tok[] = []
  for (let i = 0; i < formula.length;) {
    const ch = formula[i]
    if (/\s/.test(ch)) { i += 1; continue }
    if (/[0-9.]/.test(ch)) {
      let j = i
      while (j < formula.length && /[0-9.]/.test(formula[j])) j += 1
      const text = formula.slice(i, j)
      if (!/^\d+(\.\d+)?$/.test(text)) throw new PostureFormulaError(`公式写法不对：第 ${i + 1} 个字符附近的数字「${text}」`)
      out.push({ kind: 'num', text, at: i }); i = j; continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < formula.length && /[A-Za-z0-9_]/.test(formula[j])) j += 1
      out.push({ kind: 'name', text: formula.slice(i, j), at: i }); i = j; continue
    }
    if ('(),+-*/'.includes(ch)) { out.push({ kind: 'op', text: ch, at: i }); i += 1; continue }
    throw new PostureFormulaError(`公式写法不对：第 ${i + 1} 个字符「${ch}」不能用`)
  }
  return out
}

function pointFor(frame: PostureFrame, name: string): PosturePoint {
  if (!(POSTURE_POINTS as readonly string[]).includes(name)) {
    throw new PostureFormulaError(`不认识的关键点「${name}」；可用的关键点见体态说明（如 left_shoulder、right_hip、nose）。`)
  }
  const point = frame.points[name as PosturePointName]
  if (!point) throw new PostureFormulaError(`这次算不出：缺少关键点「${name}」。`)
  if (typeof point.visibility === 'number' && point.visibility < LOW_VISIBILITY) throw new PostureFormulaError(`这次算不出：「${name}」看不清（置信度低），不参与计算。`)
  return point
}
function midlineDistance(frame: PostureFrame, point: PosturePoint): number {
  const pairs: [PosturePointName, PosturePointName][] = [['left_shoulder', 'right_shoulder'], ['left_hip', 'right_hip']]
  const xs: number[] = []
  for (const [left, right] of pairs) {
    const a = frame.points[left], b = frame.points[right]
    if (a && b && (a.visibility ?? 1) >= LOW_VISIBILITY && (b.visibility ?? 1) >= LOW_VISIBILITY) xs.push((a.x + b.x) / 2)
  }
  if (xs.length === 0) throw new PostureFormulaError('这次算不出：找不到肩或髋来定身体中线。')
  const middle = xs.reduce((sum, value) => sum + value, 0) / xs.length
  return Math.abs(point.x - middle)
}

export function evaluatePostureFormula(formula: string, frame: PostureFrame): number {
  const toks = tokenize(formula)
  let index = 0
  const peek = () => toks[index]
  const eat = (text: string) => {
    const tok = toks[index]
    if (!tok || tok.text !== text) throw new PostureFormulaError(`公式写法不对：第 ${(tok?.at ?? formula.length) + 1} 个字符附近少了「${text}」。`)
    index += 1
  }
  const call = (name: string): number => {
    eat('(')
    const args: PosturePointName[] = []
    for (;;) {
      const tok = peek()
      if (!tok || tok.kind !== 'name') throw new PostureFormulaError(`公式写法不对：${name}(…) 里要写关键点名。`)
      args.push(tok.text as PosturePointName); index += 1
      if (peek()?.text === ',') { index += 1; continue }
      break
    }
    eat(')')
    const need = (count: number) => { if (args.length !== count) throw new PostureFormulaError(`${name}(…) 需要 ${count} 个关键点，实际写了 ${args.length} 个。`) }
    if (name === 'heightDiff') { need(2); const [a, b] = args.map(point => pointFor(frame, point)); return Math.abs((a.y - b.y) * 100) }
    if (name === 'distance') { need(2); const [a, b] = args.map(point => pointFor(frame, point)); return Math.hypot(a.x - b.x, a.y - b.y) * 100 }
    if (name === 'angle') {
      need(3); const [a, b, c] = args.map(point => pointFor(frame, point))
      const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y }
      const denom = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)
      if (denom === 0) throw new PostureFormulaError('这次算不出：三个关键点重合，夹角没有意义。')
      return Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / denom))) * 180 / Math.PI
    }
    if (name === 'symmetry') { need(2); const [a, b] = args.map(point => pointFor(frame, point)); return Math.abs(midlineDistance(frame, a) - midlineDistance(frame, b)) * 100 }
    if (name === 'midlineOffset') { need(1); const [a] = args.map(point => pointFor(frame, point)); return midlineDistance(frame, a) * 100 }
    throw new PostureFormulaError(`不认识的运算「${name}」；只支持 ${POSTURE_FORMULA_FUNCTIONS.join(' / ')}。`)
  }
  const factor = (): number => {
    const tok = peek()
    if (!tok) throw new PostureFormulaError('公式写法不对：末尾不完整。')
    if (tok.kind === 'num') { index += 1; return Number(tok.text) }
    if (tok.text === '(') { eat('('); const value = expression(); eat(')'); return value }
    if (tok.text === '-') { index += 1; return -factor() }
    if (tok.kind === 'name') {
      index += 1
      if (peek()?.text !== '(') throw new PostureFormulaError(`「${tok.text}」后面要跟括号，例如 ${tok.text}(left_shoulder, right_shoulder)。`)
      return call(tok.text)
    }
    throw new PostureFormulaError(`公式写法不对：第 ${tok.at + 1} 个字符「${tok.text}」位置不对。`)
  }
  const term = (): number => { let value = factor(); for (;;) { const tok = peek(); if (tok?.text === '*') { index += 1; value *= factor() } else if (tok?.text === '/') { index += 1; const next = factor(); if (next === 0) throw new PostureFormulaError('公式里除以了 0。'); value /= next } else return value } }
  const expression = (): number => { let value = term(); for (;;) { const tok = peek(); if (tok?.text === '+') { index += 1; value += term() } else if (tok?.text === '-') { index += 1; value -= term() } else return value } }
  const value = expression()
  if (index < toks.length) throw new PostureFormulaError(`公式写法不对：第 ${toks[index].at + 1} 个字符「${toks[index].text}」多出来了。`)
  if (!Number.isFinite(value)) throw new PostureFormulaError('公式算出来的数不是有效数字。')
  return value
}

export function validatePostureFormula(formula: string): string | null {
  try {
    // 用一副“齐全但无意义”的骨架验证语法与名字；运行时的看不清/缺点在计算时再报。
    const points: Partial<Record<PosturePointName, PosturePoint>> = {}
    POSTURE_POINTS.forEach((name, index) => { points[name] = { x: 0.2 + (index % 5) * 0.1, y: 0.1 + (index % 7) * 0.1, visibility: 1 } })
    evaluatePostureFormula(formula, { source: 'phone', view: 'front', at: new Date(0).toISOString(), width: 1, height: 1, points })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : '公式写法不对。'
  }
}

// 拖过的点优先用老师改后的坐标；指标统一按改后坐标重算。
export function effectivePoint(segment: PostureSegment, name: PosturePointName): PosturePoint | undefined {
  const override = segment.overrides?.[name]
  if (override) return { x: override.x, y: override.y, ...(segment.frame.points[name]?.visibility === undefined ? {} : { visibility: segment.frame.points[name]!.visibility }) }
  return segment.frame.points[name]
}
export function effectiveFrame(segment: PostureSegment): PostureFrame {
  const points: PostureFrame['points'] = { ...segment.frame.points }
  for (const [name, override] of Object.entries(segment.overrides ?? {})) {
    points[name as PosturePointName] = { ...(points[name as PosturePointName] ?? { x: 0, y: 0 }), x: override.x, y: override.y }
  }
  return { ...segment.frame, points }
}
export function computeMetrics(segment: PostureSegment, metrics: readonly PostureMetric[]): PostureMetricValue[] {
  const frame = effectiveFrame(segment)
  return metrics.map(metric => {
    try {
      const value = Math.round(evaluatePostureFormula(metric.formula, frame) * 10) / 10
      return { id: metric.id, name: metric.name, unit: metric.unit, status: 'ok' as const, value }
    } catch (error) {
      return { id: metric.id, name: metric.name, unit: metric.unit, status: 'unavailable' as const, value: null, reason: error instanceof Error ? error.message : '这次算不出。' }
    }
  })
}
export function computeRecordValues(record: PostureRecord): Record<string, PostureMetricValue[]> {
  const values: Record<string, PostureMetricValue[]> = {}
  for (const segment of record.segments) values[segment.id] = computeMetrics(segment, record.metrics)
  return values
}

// ---------- 趋势与失衡统计 ----------
export interface PostureTrendPoint { at: string; recordId: string; value: number | null; unit: string }
export function postureTrends(records: readonly PostureRecord[]): Record<string, { name: string; unit: string; points: PostureTrendPoint[] }> {
  const sorted = [...records].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const trends: Record<string, { name: string; unit: string; points: PostureTrendPoint[] }> = {}
  for (const record of sorted) {
    // 每条记录取“做动作前”的第一段（没有就取第一段）作为走势点。
    const segment = record.segments.find(item => item.phase === 'before') ?? record.segments[0]
    if (!segment) continue
    for (const value of record.values[segment.id] ?? computeMetrics(segment, record.metrics)) {
      const trend = trends[value.id] ?? (trends[value.id] = { name: value.name, unit: value.unit, points: [] })
      trend.points.push({ at: record.at, recordId: record.id, value: value.value, unit: value.unit })
    }
  }
  return trends
}
export function unbalancedCounts(records: readonly PostureRecord[]): Record<string, { count: number; lastAt: string; reason: string }> {
  const counts: Record<string, { count: number; lastAt: string; reason: string }> = {}
  for (const record of [...records].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))) {
    for (const segment of record.segments) {
      for (const mark of segment.marks ?? []) {
        const entry = counts[mark.point] ?? (counts[mark.point] = { count: 0, lastAt: '', reason: '' })
        entry.count += 1; entry.lastAt = record.at; entry.reason = mark.reason
      }
    }
  }
  return counts
}
export function metricDeltas(before: readonly PostureMetricValue[] | undefined, after: readonly PostureMetricValue[] | undefined): { id: string; name: string; unit: string; before: number | null; after: number | null; delta: number | null; reason?: string }[] {
  const list = [...(before ?? [])]
  for (const value of after ?? []) if (!list.some(item => item.id === value.id)) list.push(value)
  return list.map(item => {
    const next = (after ?? []).find(value => value.id === item.id)
    const a = item.value, b = next?.value ?? null
    return { id: item.id, name: item.name, unit: item.unit, before: a, after: b, delta: a === null || b === null ? null : Math.round((b - a) * 10) / 10, reason: next?.reason ?? item.reason }
  })
}

// ---------- 结构校验（签字前调用；不依赖 app 层，避免循环引用） ----------
const HEX32 = /^[0-9a-f]{32}$/

function isPoint(value: unknown): value is PosturePoint {
  if (!value || typeof value !== 'object') return false
  const point = value as { x?: unknown; y?: unknown; z?: unknown; visibility?: unknown }
  if (typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  if (point.z !== undefined && (typeof point.z !== 'number' || !Number.isFinite(point.z))) return false
  if (point.visibility !== undefined && (typeof point.visibility !== 'number' || !Number.isFinite(point.visibility) || point.visibility < 0 || point.visibility > 1)) return false
  return true
}

export function isPostureFrame(value: unknown): value is PostureFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const frame = value as PostureFrame
  if (frame.source !== 'phone' && frame.source !== 'studio') return false
  if (frame.view !== 'front' && frame.view !== 'side' && frame.view !== 'video') return false
  if (typeof frame.at !== 'string' || !Number.isFinite(Date.parse(frame.at))) return false
  if (typeof frame.width !== 'number' || !Number.isFinite(frame.width) || frame.width < 0) return false
  if (typeof frame.height !== 'number' || !Number.isFinite(frame.height) || frame.height < 0) return false
  if (!frame.points || typeof frame.points !== 'object' || Array.isArray(frame.points)) return false
  for (const [name, point] of Object.entries(frame.points)) {
    if (!(POSTURE_POINTS as readonly string[]).includes(name)) return false
    if (!isPoint(point)) return false
  }
  return true
}

export function isPostureSegment(value: unknown): value is PostureSegment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const segment = value as PostureSegment
  if (typeof segment.id !== 'string' || segment.id === '' || segment.id.length > 64) return false
  if (typeof segment.action !== 'string' || segment.action.length > 30) return false
  if (segment.phase !== 'before' && segment.phase !== 'after') return false
  if (segment.note !== undefined && (typeof segment.note !== 'string' || segment.note.length > 200)) return false
  if (!isPostureFrame(segment.frame)) return false
  for (const override of Object.values(segment.overrides ?? {})) {
    if (!override || typeof override.x !== 'number' || typeof override.y !== 'number' || !Number.isFinite(override.x) || !Number.isFinite(override.y)) return false
  }
  for (const mark of segment.marks ?? []) {
    if (!mark || !(POSTURE_POINTS as readonly string[]).includes(mark.point) || typeof mark.reason !== 'string' || mark.reason.length > 200 || mark.source !== 'teacher') return false
  }
  for (const guide of segment.guides ?? []) {
    if (!guide || (guide.kind !== 'shoulder_line' && guide.kind !== 'hip_line' && guide.kind !== 'spine_midline') || guide.source !== 'teacher') return false
  }
  return true
}

export function isPostureRecord(value: unknown): value is PostureRecord {
  const record = value as PostureRecord
  if (!record || typeof record !== 'object') return false
  if (!HEX32.test(record.id) || typeof record.student !== 'string' || typeof record.teacher !== 'string') return false
  if (record.capturedBy !== undefined && record.capturedBy !== 'student' && record.capturedBy !== 'teacher') return false
  if (!Number.isFinite(Date.parse(record.at)) || !Array.isArray(record.segments) || !Array.isArray(record.metrics)) return false
  if (record.segments.length === 0 || record.segments.length > 20) return false
  return record.segments.every(isPostureSegment)
}

// 签字前：把整段体态记录做成快照（指标值按当前坐标重算）。
export function normalizePostureForSign(record: PostureRecord, student: string): PostureRecord {
  if (!isPostureRecord(record)) throw new Error('体态记录格式无效')
  if (record.student !== student) throw new Error('体态记录不是这位学生的')
  return { ...record, values: computeRecordValues(record), metrics: record.metrics.map(item => ({ ...item })) }
}

// V2-32：老师端按自己的指标表给学生拍的骨架算数（学生端从来不算、不带数值）。
export function applyPostureMetrics(record: PostureRecord, metrics: readonly PostureMetric[]): PostureRecord {
  const snapshot = metrics.map(item => ({ ...item }))
  const next: PostureRecord = { ...record, metrics: snapshot, values: {} }
  return { ...next, values: computeRecordValues(next) }
}

// ---------- V2-32 学生在家拍：清洗成“只有关键点、视角、时间与感觉” ----------
export interface StudentPostureExpectation { student: string; teacher: string }
const VIEW_LABELS: Record<PostureView, string> = { front: '正面', side: '侧面', video: '走路视频' }

function clampedPoint(point: PosturePoint): PosturePoint {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  return {
    x: clamp(point.x), y: clamp(point.y),
    ...(point.z === undefined ? {} : { z: point.z }),
    ...(point.visibility === undefined ? {} : { visibility: clamp(point.visibility) }),
  }
}
function cleanPoints(points: PostureFrame['points']): PostureFrame['points'] {
  const out: PostureFrame['points'] = {}
  for (const name of POSTURE_POINTS) {
    const point = points[name]
    if (point) out[name] = clampedPoint(point)
  }
  return out
}

function cleanStudentSegment(segment: PostureSegment, count: number, views: Set<PostureView>): PostureSegment {
  if ((segment.marks?.length ?? 0) > 0 || (segment.guides?.length ?? 0) > 0 || Object.keys(segment.overrides ?? {}).length > 0) {
    throw new Error('学生自己拍的体态不带老师标注。')
  }
  if (segment.frame.source !== 'phone') throw new Error('学生这边只能交手机拍的骨架。')
  const view = segment.frame.view
  if (view === 'video' && count > 1) throw new Error('走路视频单独一段，不能和照片混在一起。')
  if (views.has(view)) throw new Error(view === 'video' ? '走路视频只要一段。' : `${VIEW_LABELS[view]}已经拍过了。`)
  views.add(view)
  if (!(segment.frame.width > 0) || !(segment.frame.height > 0)) throw new Error('这张照片没有实际尺寸，请重拍。')
  const note = segment.note?.trim()
  return {
    id: segment.id,
    action: view === 'video' ? '走路' : '站立',
    phase: 'before',
    ...(note ? { note: note.slice(0, 200) } : {}),
    frame: {
      source: 'phone', view, at: new Date(segment.frame.at).toISOString(),
      width: segment.frame.width, height: segment.frame.height, points: cleanPoints(segment.frame.points),
    },
  }
}

// 老师端收包/学生端发包/草稿读回共用：格式不对、夹带图片或指标、老师拍的、超过两段都拒绝。
export function sanitizeStudentPostures(value: unknown, expected: StudentPostureExpectation): PostureRecord[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('体态记录格式不对。')
  if (value.length > 2) throw new Error('体态记录最多两条。')
  const records: PostureRecord[] = []
  for (const [index, raw] of value.entries()) {
    if (!isPostureRecord(raw)) throw new Error(`第 ${index + 1} 条体态记录格式不对。`)
    if (raw.student !== expected.student) throw new Error('这条体态记录不是这位学生的。')
    if (raw.teacher !== expected.teacher) throw new Error('这条体态记录不是这位老师的。')
    if (raw.capturedBy !== 'student') throw new Error('远程问诊的体态只能是学生自己拍的。')
    if (raw.metrics.length > 0 || Object.keys(raw.values).length > 0) throw new Error('学生端不带指标数值。')
    if (raw.segments.length > 2) throw new Error('体态最多两段：正面、侧面各一张，或一段走路视频。')
    const views = new Set<PostureView>()
    const segments = raw.segments.map(segment => cleanStudentSegment(segment, raw.segments.length, views))
    const recordNote = raw.note?.trim()
    records.push({
      id: raw.id, student: expected.student, teacher: expected.teacher,
      at: new Date(raw.at).toISOString(), capturedBy: 'student',
      segments, metrics: [], values: {},
      ...(recordNote ? { note: recordNote.slice(0, 200) } : {}),
    })
  }
  return records
}

export function appendStudentPostureSegment(record: PostureRecord, segment: PostureSegment): PostureRecord {
  if (!record || record.capturedBy !== 'student') throw new Error('这不是学生自己拍的体态记录。')
  if (!isPostureSegment(segment)) throw new Error('这段体态数据格式不对。')
  const [clean] = sanitizeStudentPostures([{ ...record, segments: [...record.segments, segment] }], { student: record.student, teacher: record.teacher })
  return clean
}

export function removeStudentPostureSegment(record: PostureRecord, segmentId: string): PostureRecord | null {
  const segments = record.segments.filter(item => item.id !== segmentId)
  if (segments.length === record.segments.length) throw new Error('没有这一段。')
  if (segments.length === 0) return null
  return { ...record, segments }
}
