import { describe, expect, it } from 'vitest'
import type { Encounter } from './core/record/types'
import { pendingDraftFields } from './core/record/sign'
import {
  changeReasonText, confirmBlock, confirmHeardExams, hasPendingDraft, pendingBlockCount, pendingDraftCount,
  prescriptionChangeReasonNeeded, prescriptionDiff, prescriptionSummary, reviewBlocks, setPrescription, setTextField,
} from './review-model'

const unknown = () => ({ value: null, source: 'unknown' as const })
const draft = (value: string) => ({ value, source: 'ai_draft' as const })

export function encounter(): Encounter {
  return {
    id: 'a'.repeat(32), version: 1, kind: 'remote_async', student: 'b'.repeat(64), teacher: 'c'.repeat(64), createdAt: '2026-10-22T00:00:00.000Z',
    profile: { alias: unknown(), gender: unknown(), age: unknown(), bazi: unknown(), city: unknown() },
    intake: { chiefComplaint: { value: '睡不着', source: 'student' }, presentIllness: unknown(), history: unknown(), medsAllergies: unknown(), attachments: [] },
    fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
    judgment: { symptomSummary: draft('睡眠困扰'), pattern: draft('心脾两虚'), mechanism: unknown(), rationale: unknown() },
    plan: {
      principle: draft('益气补血'),
      prescription: { value: { items: [{ herb: '黄芪', dose: '10g' }, { herb: '当归', dose: '6g' }], days: 7 }, source: 'ai_draft' },
      homework: [{ id: 'd'.repeat(32), title: '泡脚', detail: '十五分钟', schedule: { kind: 'daily', time: '21:00' }, source: 'ai_draft' }],
      advice: draft('早睡'),
    },
  }
}

describe('V2-16 核对页分块（合成数据）', () => {
  it('草稿块按设计稿顺序出现，并标出草稿', () => {
    const blocks = reviewBlocks(encounter())
    expect(blocks.map(block => block.title)).toEqual(['判断', '方子', '作业', '医嘱'])
    expect(blocks.every(block => block.pending)).toBe(true)
    expect(blocks[1].prescription?.items.map(item => item.herb)).toEqual(['黄芪', '当归'])
    expect(pendingDraftCount(encounter())).toBeGreaterThan(0)
    expect(pendingBlockCount(encounter())).toBe(4)
    expect(hasPendingDraft(encounter())).toBe(true)
  })

  it('逐块“就这样”只清这一块的草稿；没确认完不能签字', () => {
    let current = confirmBlock(encounter(), 'judgment')
    expect(reviewBlocks(current)[0].pending).toBe(false)
    expect(reviewBlocks(current)[1].pending).toBe(true)
    expect(pendingBlockCount(current)).toBe(3)
    expect(pendingDraftFields(current).some(path => path.startsWith('judgment.'))).toBe(false)
    current = confirmBlock(confirmBlock(confirmBlock(current, 'prescription'), 'homework'), 'advice')
    expect(pendingDraftFields(current)).toEqual([])
    expect(pendingBlockCount(current)).toBe(0)
    expect(hasPendingDraft(current)).toBe(false)
  })

  it('改过的字段来源写老师，不再算草稿', () => {
    const next = setTextField(encounter(), 'judgment.pattern', '肝郁脾虚')
    expect(next.judgment.pattern).toMatchObject({ value: '肝郁脾虚', source: 'teacher' })
    expect(next.judgment.mechanism).toEqual(unknown())
    expect(pendingDraftCount(next)).toBeLessThan(pendingDraftCount(encounter()))
  })

  it('四诊是老师自己说的一屏，“看草稿”时按“您说的”确认', () => {
    const source = encounter()
    source.fourExams.look = draft('舌淡红')
    source.fourExams.pulse = draft('脉细弱')
    const next = confirmHeardExams(source)
    expect(next.fourExams.look.source).toBe('teacher')
    expect(next.fourExams.pulse.source).toBe('teacher')
    expect(pendingDraftFields(next).some(path => path.startsWith('fourExams.'))).toBe(false)
  })
})

describe('V2-16 改方差异（合成数据）', () => {
  const previous = { items: [{ herb: '黄芪', dose: '10g' }, { herb: '木香', dose: '3g' }], method: '水煎', days: 7 }
  const next = { items: [{ herb: '黄芪', dose: '10g' }, { herb: '远志', dose: '6g' }], method: '水煎', days: 7 }

  it('自动写出去了什么、加了什么', () => {
    expect(prescriptionDiff(previous, next)).toEqual({ removed: ['木香'], added: ['远志'], doseChanged: [] })
    expect(changeReasonText(previous, next)).toBe('比上次去了木香；加了远志')
  })

  it('药味、剂量、煎服法或天数有变化就要求一句理由', () => {
    expect(prescriptionChangeReasonNeeded(previous, next)).toBe(true)
    expect(prescriptionChangeReasonNeeded(previous, { ...previous })).toBe(false)
    expect(prescriptionChangeReasonNeeded(previous, { ...previous, items: [{ herb: '黄芪', dose: '12g' }, { herb: '木香', dose: '3g' }] })).toBe(true)
    expect(prescriptionChangeReasonNeeded(previous, { ...previous, days: 14 })).toBe(true)
    expect(prescriptionChangeReasonNeeded(null, next)).toBe(false)
  })

  it('改方写入理由与上一版签名事件 id，来源写老师', () => {
    const updated = setPrescription(encounter(), next, { reason: '睡不实，加远志安神', previousEventId: 'e'.repeat(64) })
    expect(updated.plan.prescription.source).toBe('teacher')
    expect(updated.plan.prescription.value).toMatchObject({ changeReason: '睡不实，加远志安神', previousOf: 'e'.repeat(64) })
    expect(prescriptionSummary(updated.plan.prescription.value)).toContain('远志 6g')
  })

  it('确认后的草稿保留原文，只标老师确认', () => {
    const next = confirmBlock(encounter(), 'prescription')
    expect(next.plan.prescription.value?.items).toHaveLength(2)
    expect(next.plan.prescription.source).toBe('teacher')
    expect(next.plan.prescription.note).toBe('ai_accepted')
    expect(next.plan.principle.value).toBe('益气补血')
  })

  it('按意见改稿的字段保留 teacher_directed，其余草稿确认成 ai_accepted', () => {
    const source = encounter()
    source.plan.prescription = { ...source.plan.prescription, note: 'teacher_directed' }
    source.plan.homework = [{ ...source.plan.homework[0], note: 'teacher_directed' }]
    const next = confirmBlock(confirmBlock(source, 'prescription'), 'homework')
    expect(next.plan.prescription).toMatchObject({ source: 'teacher', note: 'teacher_directed' })
    expect(next.plan.homework[0]).toMatchObject({ source: 'teacher', note: 'teacher_directed' })
  })
})
