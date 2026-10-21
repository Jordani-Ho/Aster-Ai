import { describe, expect, it } from 'vitest'
import { startInPersonEncounter } from './in-person'
import { isLongRecord, LONG_RECORD_FIELDS, LONG_RECORD_TEXT, recordExtent } from './fold'

// V2-13：长病历分段折叠阈值 = 全文 > 1200 字，或已填字段 > 12 个。全部合成病历。
const TEACHER = 'a'.repeat(64)
const STUDENT = 'b'.repeat(64)

function encounter() {
  return startInPersonEncounter({ teacher: TEACHER, student: STUDENT, now: new Date('2026-10-20T12:00:00.000Z') })
}

describe('长病历折叠阈值', () => {
  it('短病历不折叠', () => {
    const value = encounter()
    value.intake.chiefComplaint = { value: '最近睡不好', source: 'student' }
    value.judgment.pattern = { value: '心脾两虚', source: 'ai_draft' }
    expect(isLongRecord(value)).toBe(false)
    expect(recordExtent(value).fieldCount).toBe(2)
  })

  it('全文超过 1200 字折叠；正好 1200 字不折叠', () => {
    const exactly = encounter()
    exactly.intake.presentIllness = { value: '一'.repeat(LONG_RECORD_TEXT), source: 'student' }
    expect(recordExtent(exactly).textLength).toBe(LONG_RECORD_TEXT)
    expect(isLongRecord(exactly)).toBe(false)

    const longer = encounter()
    longer.intake.presentIllness = { value: '一'.repeat(LONG_RECORD_TEXT + 1), source: 'student' }
    expect(isLongRecord(longer)).toBe(true)
  })

  it('已填字段超过 12 个折叠；12 个不折叠', () => {
    const value = encounter()
    const fields = [
      value.intake.chiefComplaint, value.intake.presentIllness, value.intake.history, value.intake.medsAllergies,
      value.fourExams.look, value.fourExams.listenSmell, value.fourExams.ask, value.fourExams.pulse,
      value.judgment.symptomSummary, value.judgment.pattern, value.judgment.mechanism, value.judgment.rationale,
    ]
    for (const field of fields) field.value = '有'
    expect(recordExtent(value).fieldCount).toBe(LONG_RECORD_FIELDS)
    expect(isLongRecord(value)).toBe(false)

    value.plan.principle.value = '健脾'
    expect(recordExtent(value).fieldCount).toBe(LONG_RECORD_FIELDS + 1)
    expect(isLongRecord(value)).toBe(true)
  })

  it('作业也算进全文长度', () => {
    const value = encounter()
    value.plan.homework = [{
      id: 'a'.repeat(32), title: '泡脚', detail: '二'.repeat(LONG_RECORD_TEXT), source: 'teacher',
      schedule: { kind: 'daily', time: '21:00' },
    }]
    expect(isLongRecord(value)).toBe(true)
  })
})
