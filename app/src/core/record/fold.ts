import type { Encounter } from './types'

// V2-13：长病历分段折叠。阈值按已锁定口径：全文显示文本 > 1200 字，或已填字段 > 12 个。
export const LONG_RECORD_TEXT = 1200
export const LONG_RECORD_FIELDS = 12

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 字段值转成界面上会看到的文字，用于量“全文多长”。null 表示未知，不计。 */
export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(fieldText).join(' ')
  if (isObject(value)) {
    const items = value.items
    if (Array.isArray(items)) {
      return items.map(item => isObject(item) ? [item.herb, item.dose, item.note].map(part => typeof part === 'string' ? part : '').join(' ') : fieldText(item)).join('　')
    }
    return Object.values(value).map(fieldText).filter(Boolean).join(' ')
  }
  return ''
}

function fieldValues(encounter: Encounter): unknown[] {
  const values: unknown[] = [
    encounter.intake.chiefComplaint.value,
    encounter.intake.presentIllness.value,
    encounter.intake.history.value,
    encounter.intake.medsAllergies.value,
  ]
  const sections = [encounter.fourExams, encounter.judgment, encounter.plan, encounter.outcome]
  for (const section of sections) {
    if (!section) continue
    for (const [key, field] of Object.entries(section)) {
      if (key === 'homework' || Array.isArray(field)) continue
      if (isObject(field) && 'value' in field) values.push(field.value)
    }
  }
  return values
}

export interface RecordExtent {
  textLength: number
  fieldCount: number
}

/** 量整张病历草稿：已填字段数与界面文本长度（含作业）。 */
export function recordExtent(encounter: Encounter): RecordExtent {
  const values = fieldValues(encounter)
  const filled = values.map(fieldText).filter(text => text.trim() !== '')
  let textLength = filled.join('\n').length
  let fieldCount = filled.length
  for (const homework of encounter.plan.homework) {
    const text = [homework.title, homework.detail].filter(Boolean).join(' ')
    if (text.trim() !== '') { textLength += text.length; fieldCount += 1 }
  }
  return { textLength, fieldCount }
}

export function isLongRecord(encounter: Encounter): boolean {
  const extent = recordExtent(encounter)
  return extent.textLength > LONG_RECORD_TEXT || extent.fieldCount > LONG_RECORD_FIELDS
}
