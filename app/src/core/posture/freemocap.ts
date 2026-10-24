// V2-30 FreeMoCap 导入：只读它导出的文件，不引入 FreeMoCap（AGPL）代码。
// 支持当前/上一稳定版的 tidy CSV（有表头，行 = 帧 × 关键点，列含 frame,keypoint,x,y,z），
// 以及跨版本最稳的 mediapipe_body_3d_xyz.npy（(frames, 33, 3) 或 (frames, 99) 的 float 数组）。
// 坐标单位按 FreeMoCap 文档为毫米、右手系 XYZ；groundplane 对齐后 Z 向上。
// 投影口径（README 写清）：正视 = 水平 X / 竖直 Z；侧视 = 水平 Y / 竖直 Z；投到二维后归一化到 0–1，
// y 向下（越高越小）；原始 z（前后深度，毫米）随点保存，不参与公式。
import { POSTURE_POINTS, type PostureFrame, type PosturePoint, type PosturePointName, type PostureSource, type PostureView } from '../../../../domain/tcm/posture'

export interface FreeMoCapOptions { view?: 'front' | 'side'; at?: string }
export class FreeMoCapImportError extends Error { constructor(message: string) { super(message); this.name = 'FreeMoCapImportError' } }

const BODY_ALIASES: Record<string, PosturePointName> = {
  nose: 'nose',
  left_shoulder: 'left_shoulder', right_shoulder: 'right_shoulder',
  left_elbow: 'left_elbow', right_elbow: 'right_elbow',
  left_wrist: 'left_wrist', right_wrist: 'right_wrist',
  left_hip: 'left_hip', right_hip: 'right_hip',
  left_knee: 'left_knee', right_knee: 'right_knee',
  left_ankle: 'left_ankle', right_ankle: 'right_ankle',
  left_heel: 'left_heel', right_heel: 'right_heel',
  left_foot_index: 'left_foot_index', right_foot_index: 'right_foot_index',
  left_eye: 'left_eye', right_eye: 'right_eye', left_ear: 'left_ear', right_ear: 'right_ear',
  left_eye_inner: 'left_eye_inner', left_eye_outer: 'left_eye_outer', right_eye_inner: 'right_eye_inner', right_eye_outer: 'right_eye_outer',
  mouth_left: 'mouth_left', mouth_right: 'mouth_right',
  left_pinky: 'left_pinky', right_pinky: 'right_pinky', left_index: 'left_index', right_index: 'right_index',
  left_thumb: 'left_thumb', right_thumb: 'right_thumb',
}
// 导入必须有这些点，否则体态指标算不出，直接拒绝而不是猜。
const REQUIRED: PosturePointName[] = ['nose', 'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle']

function alias(name: string): PosturePointName | null {
  const key = name.trim().toLowerCase().replace(/^mediapipe[._]?/, '').replace(/^body[._]/, '').replace(/[ .-]+/g, '_')
  if (key in BODY_ALIASES) return BODY_ALIASES[key]
  return null
}
function number(text: string | undefined): number | null {
  if (text === undefined || text === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

// 3D 点投到二维后归一化：horizontal/vertical 由视角决定；vertical 翻转成屏幕 y（向下）。
function project(points: Record<string, { x: number; y: number; z: number }>, view: 'front' | 'side'): Partial<Record<PosturePointName, PosturePoint>> {
  const rows = Object.entries(points).map(([name, value]) => ({ name: alias(name), ...value })).filter(item => item.name !== null) as { name: PosturePointName; x: number; y: number; z: number }[]
  if (rows.length === 0) throw new FreeMoCapImportError('文件里没有可识别的关键点（需要 FreeMoCap 导出文件）。')
  const missing = REQUIRED.filter(name => !rows.some(item => item.name === name))
  if (missing.length > 0) throw new FreeMoCapImportError('文件缺少这些关键点，算不出体态指标：' + missing.join('、'))
  const horizontal = rows.map(item => view === 'front' ? item.x : item.y)
  const vertical = rows.map(item => item.z)
  const minH = Math.min(...horizontal), maxH = Math.max(...horizontal), minV = Math.min(...vertical), maxV = Math.max(...vertical)
  const spanH = maxH - minH, spanV = maxV - minV
  if (!(spanH > 0) || !(spanV > 0)) throw new FreeMoCapImportError('关键点位置全都一样，没法归一化（文件可能不是三维骨架）。')
  const out: Partial<Record<PosturePointName, PosturePoint>> = {}
  for (const item of rows) {
    const h = (view === 'front' ? item.x : item.y) - minH
    const v = item.z - minV
    out[item.name] = { x: h / spanH, y: 1 - v / spanV, z: item.z }
  }
  return out
}

function pickFrame(rows: { frame: number; points: Record<string, { x: number; y: number; z: number }> }[]): { frame: number; points: Record<string, { x: number; y: number; z: number }> } {
  if (rows.length === 0) throw new FreeMoCapImportError('文件里一帧都没有。')
  return rows[Math.floor((rows.length - 1) / 2)] // 取中间帧，避免开头结尾的未稳定帧
}

export function parseFreeMoCapCsv(text: string, options: FreeMoCapOptions = {}): PostureFrame {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim() !== '')
  if (lines.length < 2) throw new FreeMoCapImportError('这不是 FreeMoCap 导出的 by-frame CSV（没有表头或没有数据行）。')
  const header = lines[0].split(',').map(item => item.trim().toLowerCase())
  const column = (name: string) => header.indexOf(name)
  const frameAt = column('frame'), keypointAt = column('keypoint'), modelAt = column('model')
  const xAt = column('x'), yAt = column('y'), zAt = column('z')
  if (xAt < 0 || yAt < 0 || zAt < 0) throw new FreeMoCapImportError('CSV 缺少 x/y/z 列；请用 FreeMoCap 导出的 freemocap_data_by_frame.csv 或 {recording}_by_frame.csv。')
  const byFrame = new Map<number, Record<string, { x: number; y: number; z: number }>>()
  const models = new Set<string>()
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    const name = cells[keypointAt >= 0 ? keypointAt : 1]
    const model = modelAt >= 0 ? cells[modelAt] : ''
    if (model) models.add(model)
    const frame = frameAt >= 0 ? Number(cells[frameAt]) : 0
    const x = number(cells[xAt]), y = number(cells[yAt]), z = number(cells[zAt])
    if (name === undefined || !Number.isSafeInteger(frame) || x === null || y === null || z === null) continue
    if (!byFrame.has(frame)) byFrame.set(frame, {})
    byFrame.get(frame)![name] = { x, y, z }
  }
  const bodyModel = [...models].find(model => /mediapipe|body/i.test(model)) ?? ''
  if (bodyModel && models.size > 1) {
    // 只保留 body 模型（hand/face 的点不影响体态）：按行再筛一次。
    for (const frame of [...byFrame.keys()]) {
      const filtered: Record<string, { x: number; y: number; z: number }> = {}
      for (const line of lines.slice(1)) {
        const cells = line.split(',')
        if (Number(cells[frameAt >= 0 ? frameAt : 0]) !== frame) continue
        if (cells[modelAt] !== bodyModel) continue
        const name = cells[keypointAt]
        const x = number(cells[xAt]), y = number(cells[yAt]), z = number(cells[zAt])
        if (name && x !== null && y !== null && z !== null) filtered[name] = { x, y, z }
      }
      byFrame.set(frame, filtered)
    }
  }
  const rows = [...byFrame.entries()].sort((left, right) => left[0] - right[0]).map(([frame, points]) => ({ frame, points }))
  const chosen = pickFrame(rows)
  const view = options.view ?? 'front'
  const frame: PostureFrame = { source: 'studio' as PostureSource, view: (view === 'front' ? 'front' : 'side') as PostureView, at: options.at ?? new Date().toISOString(), width: 0, height: 0, points: project(chosen.points, view) }
  return frame
}

// 读取 NPY（.npy）文件字节：float32/float64，形状 (frames, N, 3) 或 (frames, 99)；N 必须 ≥ 33。
export function parseFreeMoCapNpy(bytes: Uint8Array, options: FreeMoCapOptions = {}): PostureFrame {
  const view = decodeNpy(bytes)
  const { shape, data } = view
  if (shape.length < 2) throw new FreeMoCapImportError('npy 维度不对：至少要是 (帧数, 关键点数, 3)。')
  const [frames, count] = shape
  if (frames <= 0) throw new FreeMoCapImportError('文件里一帧都没有。')
  const coords = count === 3 && shape.length === 3 ? count : shape.length === 2 ? 3 : 3
  const flat = shape.length === 2 ? count / 3 : count
  if (!Number.isSafeInteger(flat) || flat < 33) throw new FreeMoCapImportError(`npy 关键点数不对：${flat}（至少要 33 个 MediaPipe body 关键点）。`)
  const stride = shape.length === 2 ? flat * 3 : flat * coords
  const middle = Math.floor((frames - 1) / 2)
  const points: Record<string, { x: number; y: number; z: number }> = {}
  const names = POSTURE_POINTS
  for (let index = 0; index < flat && index < names.length; index += 1) {
    const base = middle * stride + index * 3
    points[names[index]] = { x: data[base], y: data[base + 1], z: data[base + 2] }
  }
  return { source: 'studio', view: (options.view ?? 'front') as PostureView, at: options.at ?? new Date().toISOString(), width: 0, height: 0, points: project(points, options.view ?? 'front') }
}

interface NpyView { shape: number[]; data: Float64Array }
function decodeNpy(bytes: Uint8Array): NpyView {
  if (bytes.length < 10 || String.fromCharCode(...bytes.subarray(0, 6)) !== '\x93NUMPY') throw new FreeMoCapImportError('这不是 .npy 文件；请用 FreeMoCap 导出的 mediapipe_body_3d_xyz.npy。')
  const major = bytes[6]
  const headerLength = major === 1 ? bytes[8] | (bytes[9] << 8) : bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24)
  const headerStart = major === 1 ? 10 : 12
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength))
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] ?? ''
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? ''
  const shape = shapeText.split(',').map(item => item.trim()).filter(Boolean).map(Number)
  const fortran = /'fortran_order':\s*True/.test(header)
  if (fortran) throw new FreeMoCapImportError('npy 是列优先（fortran）格式，请重新导出为标准 numpy 数组。')
  const little = descr.includes('<') || (!descr.includes('>') && true)
  const kind = descr.replace(/[<>=|]/g, '')
  const byteSize = kind === 'f4' ? 4 : kind === 'f8' ? 8 : 0
  if (!byteSize || !little && descr.includes('>')) throw new FreeMoCapImportError('npy 数据类型不支持（只支持小端 float32/float64）。')
  const offset = headerStart + headerLength
  const count = shape.reduce((product, value) => product * value, 1)
  if (!Number.isSafeInteger(count) || count <= 0 || offset + count * byteSize > bytes.length) throw new FreeMoCapImportError('npy 文件长度与表头不一致，可能没导出完整。')
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
  const data = new Float64Array(count)
  for (let index = 0; index < count; index += 1) data[index] = byteSize === 4 ? view.getFloat32(index * 4, true) : view.getFloat64(index * 8, true)
  return { shape, data }
}
