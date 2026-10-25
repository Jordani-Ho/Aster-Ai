import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  LOW_VISIBILITY, computeMetrics, effectiveFrame, isPostureRecord,
  metricDeltas, normalizePostureForSign, postureTrends, unbalancedCounts,
  validatePostureFormula,
} from '../../../../domain/tcm/posture'
import type { PostureFrame, PostureMetric, PostureRecord, PostureSegment } from '../../../../domain/tcm/posture'
import { parseFreeMoCapCsv, parseFreeMoCapNpy } from './freemocap'
import { loadDefaultPostureMetrics, postureHomework, validatePostureMetrics } from './index'

const privateKey = generateSecretKey()
const identity = { publicKey: getPublicKey(privateKey), privateKey }
const student = 'b'.repeat(64)

function frame(overrides: Record<string, Partial<{ x: number; y: number; visibility?: number }>> = {}): PostureFrame {
  const points: PostureFrame['points'] = {
    nose: { x: 0.5, y: 0.12, visibility: 0.9 },
    left_shoulder: { x: 0.4, y: 0.3, visibility: 0.9 }, right_shoulder: { x: 0.6, y: 0.32, visibility: 0.9 },
    left_hip: { x: 0.44, y: 0.55, visibility: 0.9 }, right_hip: { x: 0.56, y: 0.56, visibility: 0.9 },
    left_knee: { x: 0.44, y: 0.75, visibility: 0.9 }, right_knee: { x: 0.56, y: 0.75, visibility: 0.9 },
    left_ankle: { x: 0.44, y: 0.95, visibility: 0.9 }, right_ankle: { x: 0.56, y: 0.95, visibility: 0.9 },
  }
  for (const [name, patch] of Object.entries(overrides)) points[name as keyof typeof points] = { ...points[name as keyof typeof points]!, ...patch }
  return { source: 'phone', view: 'front', at: '2026-10-01T00:00:00.000Z', width: 300, height: 400, points }
}
function segment(patch: Partial<PostureSegment> = {}): PostureSegment {
  return { id: 'f'.repeat(32), action: '站立', phase: 'before', frame: frame(), ...patch }
}
function record(segments: PostureSegment[], metrics: PostureMetric[], at = '2026-10-01T00:00:00.000Z'): PostureRecord {
  const base: PostureRecord = { id: 'e'.repeat(32), student, teacher: identity.publicKey, at, segments, metrics, values: {} }
  base.values = Object.fromEntries(segments.map(item => [item.id, computeMetrics(item, metrics)]))
  return base
}

describe('V2-30 公式白名单', () => {
  it('四条示例指标都能算：两肩高低差、骨盆倾斜、头前伸、脊柱偏离中线', () => {
    const metrics = loadDefaultPostureMetrics()
    const values = computeMetrics(segment(), metrics)
    expect(values.map(value => value.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(values[0].value).toBeCloseTo(2, 1) // |0.3-0.32| *100
    expect(values[1].value).toBeCloseTo(1, 1)
    expect(values[2].value).toBeGreaterThan(0)
    expect(values[3].value).toBeGreaterThanOrEqual(0)
  })
  it('只允许白名单运算；写错时说清位置和原因', () => {
    expect(validatePostureFormula('heightDiff(left_shoulder, right_shoulder)')).toBeNull()
    expect(validatePostureFormula('heightDiff(left_shoulder)')).toMatch(/需要 2 个关键点/)
    expect(validatePostureFormula('foobar(left_shoulder, right_shoulder)')).toMatch(/不认识的运算「foobar」/)
    expect(validatePostureFormula('heightDiff(left_shoulder, right_knee2)')).toMatch(/不认识的关键点「right_knee2」/)
    expect(validatePostureFormula('distance(left_shoulder right_shoulder)')).toMatch(/少了「,」|写法不对/)
    expect(validatePostureFormula('distance(left_shoulder, right_shoulder))')).toMatch(/多出来了/)
  })
  it('置信度低的点不参与计算：这条指标显示“这次算不出”，不编数', () => {
    const metrics = loadDefaultPostureMetrics()
    const values = computeMetrics(segment({ frame: frame({ right_shoulder: { visibility: LOW_VISIBILITY - 0.1 } }) }), metrics)
    expect(values[0].status).toBe('unavailable')
    expect(values[0].value).toBeNull()
    expect(values[0].reason).toMatch(/看不清/)
    expect(values[1].status).toBe('ok')
  })
  it('看不清或缺失的点不算数；颜色/单位由老师定义', () => {
    const metrics: PostureMetric[] = [{ id: 'knee', name: '左右膝高低差', formula: 'heightDiff(left_knee, right_knee)', unit: 'cm' }]
    expect(computeMetrics(segment({ frame: frame({ right_knee: { x: 0.56, y: 0.8 } }) }), metrics)[0].value).toBeCloseTo(5, 1)
    const missingFrame = frame(); delete missingFrame.points.right_knee
    const missing = segment({ frame: missingFrame })
    expect(computeMetrics(missing, metrics)[0]).toMatchObject({ status: 'unavailable', value: null, reason: expect.stringContaining('缺少关键点') })
  })
})

describe('V2-30 老师改点重算', () => {
  it('拖动点后标记“老师改过”，指标按改后坐标重算', () => {
    const metrics = loadDefaultPostureMetrics()
    const original = segment()
    const dragged = segment({ overrides: { right_shoulder: { x: 0.6, y: 0.4, source: 'teacher' } } })
    expect(computeMetrics(dragged, metrics)[0].value).toBeCloseTo(10, 1)
    expect(computeMetrics(original, metrics)[0].value).toBeCloseTo(2, 1)
    expect(effectiveFrame(dragged).points.right_shoulder).toMatchObject({ x: 0.6, y: 0.4 })
  })
})

describe('V2-30 FreeMoCap 导入', () => {
  const rows: [number, string, number, number, number][] = [
    [0, 'nose', 0, 0, 1600], [0, 'left_shoulder', -200, 0, 1400], [0, 'right_shoulder', 200, 0, 1400],
    [0, 'left_hip', -150, 0, 900], [0, 'right_hip', 150, 0, 900], [0, 'left_knee', -150, 0, 500],
    [0, 'right_knee', 150, 0, 500], [0, 'left_ankle', -150, 0, 100], [0, 'right_ankle', 150, 0, 100],
    [1, 'nose', 0, 0, 1600], [1, 'left_shoulder', -200, 0, 1400], [1, 'right_shoulder', 200, 0, 1400],
    [1, 'left_hip', -150, 0, 900], [1, 'right_hip', 150, 0, 900], [1, 'left_knee', -150, 0, 500],
    [1, 'right_knee', 150, 0, 500], [1, 'left_ankle', -150, 0, 100], [1, 'right_ankle', 150, 0, 100],
  ]
  function csv(): string {
    const header = 'frame,keypoint,x,y,z,model'
    return [header, ...rows.map(([f, k, x, y, z]) => `${f},${k},${x},${y},${z},mediapipe.body`)].join('\n')
  }
  it('tidy CSV：取中间帧、投到二维归一化，能算同一套指标', () => {
    const imported = parseFreeMoCapCsv(csv(), { view: 'front', at: '2026-10-02T00:00:00.000Z' })
    expect(imported.source).toBe('studio')
    expect(imported.view).toBe('front')
    expect(imported.points.left_shoulder!.y).toBeLessThan(imported.points.left_hip!.y)
    expect(imported.points.left_shoulder!.x).toBeCloseTo(0, 2)
    expect(imported.points.left_shoulder!.z).toBe(1400)
    const values = computeMetrics(segment({ frame: imported }), loadDefaultPostureMetrics())
    expect(values.map(value => value.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })
  it('npy：float32 (frames,33,3) 读中间帧；坏文件给明确错误', () => {
    const frames = 2, count = 33
    const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 33, 3), }"
    const headerLength = header.length + 1 + ((64 - ((10 + header.length + 1) % 64)) % 64)
    const bytes = new Uint8Array(10 + headerLength + frames * count * 3 * 4)
    bytes.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, headerLength & 0xff, (headerLength >> 8) & 0xff])
    bytes.set(new TextEncoder().encode(header), 10)
    const view = new DataView(bytes.buffer, bytes.byteOffset + 10 + headerLength)
    const points: Record<string, [number, number, number]> = { nose: [0, 0, 1600], left_shoulder: [-200, 0, 1400], right_shoulder: [200, 0, 1400], left_hip: [-150, 0, 900], right_hip: [150, 0, 900], left_knee: [-150, 0, 500], right_knee: [150, 0, 500], left_ankle: [-150, 0, 100], right_ankle: [150, 0, 100] }
    const names = ['nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer', 'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index', 'left_thumb', 'right_thumb', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index']
    for (const frameIndex of [0, 1]) for (const [index, name] of names.entries()) {
      const point = points[name] ?? [0, 0, 800]
      const base = frameIndex * count * 3 * 4 + index * 3 * 4
      view.setFloat32(base, point[0], true); view.setFloat32(base + 4, point[1], true); view.setFloat32(base + 8, point[2], true)
    }
    const imported = parseFreeMoCapNpy(bytes, { view: 'front' })
    expect(imported.points.right_shoulder!.x).toBeCloseTo(1, 2)
    expect(() => parseFreeMoCapNpy(new Uint8Array([1, 2, 3]))).toThrow(/不是 \.npy/)
    expect(() => parseFreeMoCapCsv('frame,keypoint,x\n0,nose,1')).toThrow(/x\/y\/z/)
    expect(() => parseFreeMoCapCsv('frame,keypoint,x,y,z,model\n0,nose,1,2,3,mediapipe.body')).toThrow(/缺少这些关键点/)
  })
})

describe('V2-30 记录、趋势与作业', () => {
  it('六次记录趋势；标过三次“失衡”的节点显示 3 次', () => {
    const metrics = loadDefaultPostureMetrics()
    const records: PostureRecord[] = []
    for (let index = 0; index < 6; index += 1) {
      const mark = index < 3 ? [{ point: 'left_shoulder' as const, reason: '左肩高', source: 'teacher' as const }] : []
      records.push(record([segment({ marks: mark })], metrics, new Date(Date.UTC(2026, 6 + index, 1)).toISOString()))
    }
    const trends = postureTrends(records)
    expect(Object.values(trends).every(trend => trend.points.length === 6)).toBe(true)
    const counts = unbalancedCounts(records)
    expect(counts.left_shoulder.count).toBe(3)
    expect(counts.left_shoulder.reason).toBe('左肩高')
  })
  it('前后两段对比：指标变化按各自坐标算', () => {
    const metrics = loadDefaultPostureMetrics()
    const before = segment()
    const after = segment({ phase: 'after', frame: frame({ left_shoulder: { x: 0.4, y: 0.34 }, right_shoulder: { x: 0.6, y: 0.34 } }) })
    const deltas = metricDeltas(computeMetrics(before, metrics), computeMetrics(after, metrics))
    expect(deltas[0].before).toBeCloseTo(2, 1)
    expect(deltas[0].after).toBeCloseTo(0, 1)
    expect(deltas[0].delta).toBeCloseTo(-2, 1)
  })
  it('签字前快照重算；非面诊/别的学生由 sign 校验拒绝（结构校验在这里）', () => {
    const metrics = loadDefaultPostureMetrics()
    const original = record([segment()], metrics)
    const snapshot = normalizePostureForSign(original, student)
    expect(snapshot.values[original.segments[0].id][0].value).toBeCloseTo(2, 1)
    expect(() => normalizePostureForSign(original, 'c'.repeat(64))).toThrow(/不是这位学生的/)
    expect(isPostureRecord(snapshot)).toBe(true)
    expect(isPostureRecord({ ...snapshot, segments: [] })).toBe(false)
  })
  it('指标校验：白名单与重复编号；动作一键变作业沿用现有 Homework', () => {
    expect(validatePostureMetrics(loadDefaultPostureMetrics()).ok).toBe(true)
    expect(validatePostureMetrics([{ id: 'x', name: '错', formula: 'foo(left_knee)', unit: '%' }])).toMatchObject({ ok: false, error: expect.stringContaining('不认识的运算') })
    expect(validatePostureMetrics([{ id: 'x', name: 'a', formula: 'heightDiff(left_knee, right_knee)', unit: '%' }, { id: 'x', name: 'b', formula: 'heightDiff(left_knee, right_knee)', unit: '%' }])).toMatchObject({ ok: false })
    const homework = postureHomework('弯腰', 'c'.repeat(32))
    expect(homework).toMatchObject({ id: 'c'.repeat(32), title: '体态练习：弯腰', source: 'teacher', schedule: { kind: 'daily', time: '21:00' } })
  })
  it('老师新加一条指标：下次记录自动算出来（computeMetrics 用当前指标表）', () => {
    const knee: PostureMetric = { id: 'knee', name: '左右膝高低差', formula: 'heightDiff(left_knee, right_knee)', unit: '%' }
    const values = computeMetrics(segment({ frame: frame({ right_knee: { x: 0.56, y: 0.65 } }) }), loadDefaultPostureMetrics().concat(knee))
    expect(values.at(-1)).toMatchObject({ id: 'knee', status: 'ok' })
    expect(values.at(-1)!.value).toBeCloseTo(10, 1)
  })
  it('签字：面诊病历可以带体态记录；远程问诊只能带学生自己拍的，旧病历没有这个字段照常', async () => {
    const { startInPersonEncounter } = await import('../record/in-person')
    const { signEncounter } = await import('../record/sign')
    const metrics = loadDefaultPostureMetrics()
    const recordWithPosture = record([segment()], metrics)
    const inPerson = startInPersonEncounter({ teacher: identity.publicKey, student })
    inPerson.postures = [recordWithPosture]
    expect(() => signEncounter(inPerson, identity.privateKey)).not.toThrow()
    // V2-32：老师当场的记录（没有 capturedBy: 'student'）不能混进远程问诊病历。
    const remote = { ...inPerson, kind: 'remote_async' as const }
    expect(() => signEncounter(remote, identity.privateKey)).toThrow(/学生自己拍/)
    const old = { ...inPerson } as Record<string, unknown>
    delete old.postures
    expect(() => signEncounter(old as unknown as typeof inPerson, identity.privateKey)).not.toThrow()
  })
})
