import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  applyPostureMetrics, isPostureRecord, sanitizeStudentPostures,
  type PostureFrame, type PostureRecord, type PostureSegment,
} from '../../../../domain/tcm/posture'
import { appendStudentPostureSegment, newStudentPostureRecord, newStudentPostureSegment, removeStudentPostureSegment } from './index'
import { loadDefaultPostureMetrics } from './index'
import { signEncounter } from '../record/sign'
import { startInPersonEncounter } from '../record/in-person'

// V2-32：学生在家拍体态——只传关键点、学生端不算指标；老师端按老师公式算。
const privateKey = generateSecretKey()
const identity = { publicKey: getPublicKey(privateKey), privateKey }
const student = 'b'.repeat(64)
const otherStudent = 'd'.repeat(64)
const otherTeacher = 'e'.repeat(64)

function frame(view: 'front' | 'side' | 'video' = 'front'): PostureFrame {
  return {
    source: 'phone', view, at: '2026-10-20T08:00:00.000Z', width: 300, height: 400,
    points: {
      nose: { x: 0.5, y: 0.12, visibility: 0.95 },
      left_shoulder: { x: 0.4, y: 0.3, visibility: 0.95 }, right_shoulder: { x: 0.6, y: 0.32, visibility: 0.95 },
      left_hip: { x: 0.44, y: 0.55, visibility: 0.95 }, right_hip: { x: 0.56, y: 0.56, visibility: 0.95 },
      left_knee: { x: 0.44, y: 0.75, visibility: 0.95 }, right_knee: { x: 0.56, y: 0.75, visibility: 0.95 },
      left_ankle: { x: 0.44, y: 0.95, visibility: 0.95 }, right_ankle: { x: 0.56, y: 0.95, visibility: 0.95 },
    },
  }
}
function segment(view: 'front' | 'side' | 'video' = 'front', note?: string): PostureSegment {
  return newStudentPostureSegment(frame(view), note)
}
function studentRecord(segments: PostureSegment[] = []): PostureRecord {
  return newStudentPostureRecord(student, identity.publicKey, segments)
}

describe('V2-32 学生体态记录：只有关键点，学生端不算指标', () => {
  it('记录来源是学生；metrics/values 为空；时间、视角、感觉都在', () => {
    const record = studentRecord([segment('front', '站久了左肩酸')])
    expect(record.capturedBy).toBe('student')
    expect(record.student).toBe(student)
    expect(record.teacher).toBe(identity.publicKey)
    expect(record.metrics).toEqual([])
    expect(record.values).toEqual({})
    expect(record.segments[0].frame.view).toBe('front')
    expect(record.segments[0].note).toBe('站久了左肩酸')
    expect(isPostureRecord(record)).toBe(true)
  })

  it('采集规则：正面、侧面各一张，或一段走路视频；视频必须单独一段', () => {
    let record = studentRecord()
    record = appendStudentPostureSegment(record, segment('front'))
    record = appendStudentPostureSegment(record, segment('side'))
    expect(record.segments.map(item => item.frame.view)).toEqual(['front', 'side'])
    expect(() => appendStudentPostureSegment(record, segment('front'))).toThrow(/正面/)
    const video = studentRecord([segment('video')])
    expect(video.segments[0].action).toBe('走路')
    expect(() => appendStudentPostureSegment(video, segment('front'))).toThrow(/视频/)
    expect(() => appendStudentPostureSegment(studentRecord([segment('video')]), segment('video'))).toThrow(/视频/)
    expect(removeStudentPostureSegment(record, record.segments[0].id)!.segments).toHaveLength(1)
  })

  it('发出去前清洗：只留关键点、视角、时间与感觉；图片字节和额外字段一律丢掉', () => {
    const dirty = JSON.parse(JSON.stringify(studentRecord([segment('front', '走路有点歪')]))) as Record<string, unknown>
    const segments = dirty.segments as Record<string, unknown>[]
    ;(segments[0].frame as Record<string, unknown>).photo = 'data:image/jpeg;base64,AAAA'
    ;((segments[0].frame as { points: Record<string, Record<string, unknown>> }).points.left_shoulder).raw = 'data:image/png;base64,BBBB'
    segments[0].image = 'data:image/png;base64,CCCC'
    ;(dirty as Record<string, unknown>).extra = 'data:image/png;base64,DDDD'
    const [clean] = sanitizeStudentPostures([dirty], { student, teacher: identity.publicKey })
    expect(JSON.stringify(clean)).not.toContain('data:image')
    expect(clean.metrics).toEqual([])
    expect(clean.values).toEqual({})
    expect(clean.segments[0].note).toBe('走路有点歪')
    expect(clean.capturedBy).toBe('student')
    expect(Object.keys(clean)).not.toContain('extra')
  })

  it('拒收：老师拍的、带标注/拖点、别的学生或老师、超过两段、混着指标都不收', () => {
    const base = studentRecord([segment('front')])
    const expectReject = (value: unknown) => expect(() => sanitizeStudentPostures(value, { student, teacher: identity.publicKey })).toThrow()
    expectReject([{ ...base, capturedBy: 'teacher' }])
    expectReject([{ ...base, capturedBy: undefined }])
    expectReject([{ ...base, student: otherStudent }])
    expectReject([{ ...base, teacher: otherTeacher }])
    expectReject([{ ...base, metrics: loadDefaultPostureMetrics() }])
    expectReject([{ ...base, segments: [...base.segments, segment('side'), segment('front')] }])
    expectReject([{ ...base, segments: [{ ...base.segments[0], marks: [{ point: 'left_shoulder', reason: '左肩高', source: 'teacher' }] }] }])
    expectReject([{ ...base, segments: [{ ...base.segments[0], overrides: { right_shoulder: { x: 0.6, y: 0.4, source: 'teacher' } } }] }])
    expect(sanitizeStudentPostures(undefined, { student, teacher: identity.publicKey })).toEqual([])
  })
})

describe('V2-32 老师端按老师的公式算', () => {
  it('学生包里没有数值；老师用自己 settings 的指标算，得到指标快照', () => {
    const record = studentRecord([segment('front')])
    expect(record.values).toEqual({})
    const scored = applyPostureMetrics(record, loadDefaultPostureMetrics())
    expect(scored.capturedBy).toBe('student')
    expect(scored.values[record.segments[0].id].map(value => value.name)).toContain('两肩高低差')
    expect(scored.values[record.segments[0].id][0].value).toBeCloseTo(2, 1)
    // 原记录不被改写
    expect(record.values).toEqual({})
  })

  it('签字：远程问诊可以带学生自己拍的骨架；老师拍的、带标注的不能混进来', () => {
    const scored = applyPostureMetrics(studentRecord([segment('front')]), loadDefaultPostureMetrics())
    const remote = { ...startInPersonEncounter({ teacher: identity.publicKey, student }), kind: 'remote_async' as const, postures: [scored] }
    const event = signEncounter(remote, identity.privateKey)
    const signed = JSON.parse(event.content) as { postures: PostureRecord[] }
    expect(signed.postures[0].capturedBy).toBe('student')
    expect(signed.postures[0].values[scored.segments[0].id][0].value).toBeCloseTo(2, 1)

    const teacherCaptured = { ...scored, capturedBy: undefined }
    expect(() => signEncounter({ ...remote, postures: [teacherCaptured] }, identity.privateKey)).toThrow(/学生自己拍/)
    const marked = { ...scored, segments: [{ ...scored.segments[0], marks: [{ point: 'left_shoulder' as const, reason: '左肩高', source: 'teacher' as const }] }] }
    expect(() => signEncounter({ ...remote, postures: [marked] }, identity.privateKey)).toThrow(/学生自己拍|标注/)
  })

  it('面诊病历照旧：老师自己拍/导入的体态记录仍可签字', () => {
    const inPerson = startInPersonEncounter({ teacher: identity.publicKey, student })
    inPerson.postures = [applyPostureMetrics({ ...studentRecord([segment('front')]), capturedBy: undefined }, loadDefaultPostureMetrics())]
    expect(() => signEncounter(inPerson, identity.privateKey)).not.toThrow()
  })

  it('学生端验签：远程签字病历带学生骨架能收；把标志改回老师拍的那份被拒', async () => {
    const { verifySignedEncounter } = await import('../record/sign')
    const scored = applyPostureMetrics(studentRecord([segment('front')]), loadDefaultPostureMetrics())
    const remote = { ...startInPersonEncounter({ teacher: identity.publicKey, student }), kind: 'remote_async' as const, postures: [scored] }
    const event = signEncounter(remote, identity.privateKey)
    const received = verifySignedEncounter(event, { student, teacher: identity.publicKey })
    expect(received.postures?.[0].capturedBy).toBe('student')
    expect(received.postures?.[0].values[scored.segments[0].id][0].value).toBeCloseTo(2, 1)
    // 老师端也会做同样的纵深防御：一份被改标志的签名内容在验签后仍不能带着老师标注出现在远程病历里。
    const forged = { ...received, postures: [{ ...scored, capturedBy: undefined }] }
    const forgedEvent = { ...event, content: JSON.stringify(forged) }
    const { getEventHash } = await import('nostr-tools/pure')
    forgedEvent.id = getEventHash(forgedEvent as never)
    expect(() => verifySignedEncounter(forgedEvent, { student, teacher: identity.publicKey })).toThrow(/签名|学生自己拍/)
  })
})
