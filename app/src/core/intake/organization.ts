import type { Field, IntakeOriginal, OrganizedIntake, OrganizedIntakeField, OrganizedIntakeKey } from '../record/types'

export const ORGANIZED_KEYS = ['chiefComplaint', 'presentIllness', 'history', 'medsAllergies'] as const satisfies readonly OrganizedIntakeKey[]

export function validOriginals(value: unknown): value is IntakeOriginal[] {
  if (!Array.isArray(value) || value.length > 500) return false
  const seen = new Set<number>()
  return value.every((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const line = item as Record<string, unknown>
    if (!Number.isSafeInteger(line.id) || (line.id as number) < 1 || seen.has(line.id as number)) return false
    if (line.id !== index + 1 || typeof line.text !== 'string' || line.text.trim() === '' || line.text.length > 2000) return false
    if (line.source !== 'spoken' && line.source !== 'followup') return false
    seen.add(line.id as number)
    return true
  })
}

/** 结构与引用均由代码校验；具体语义仍由学生/老师本人核对。 */
export function validateOrganizedIntake(value: unknown, originals: readonly IntakeOriginal[]): OrganizedIntake | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validOriginals(originals)) return null
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !ORGANIZED_KEYS.includes(key as OrganizedIntakeKey))) return null
  const available = new Set(originals.map(line => line.id))
  const clean = {} as OrganizedIntake
  for (const key of ORGANIZED_KEYS) {
    const field = raw[key]
    if (!field || typeof field !== 'object' || Array.isArray(field)) return null
    const item = field as Record<string, unknown>
    if (!(item.text === null || (typeof item.text === 'string' && item.text.trim() !== '' && item.text.length <= 1000))) return null
    if (!Array.isArray(item.citations) || item.citations.length > 100) return null
    const citations = item.citations
    if (!citations.every(id => Number.isSafeInteger(id) && available.has(id as number))) return null
    if (new Set(citations).size !== citations.length) return null
    if (item.text === null ? citations.length !== 0 : citations.length === 0) return null
    clean[key] = { text: item.text as string | null, citations: [...citations] as number[] }
  }
  return clean
}

export function emptyOrganizedIntake(): OrganizedIntake {
  return {
    chiefComplaint: { text: null, citations: [] },
    presentIllness: { text: null, citations: [] },
    history: { text: null, citations: [] },
    medsAllergies: { text: null, citations: [] },
  }
}

/** 无模型或模型输出不合格时，安全地按原句分栏，不把追问回答混入现病史。 */
export function rawOrganization(originals: readonly IntakeOriginal[]): OrganizedIntake {
  const spoken = originals.filter(line => line.source === 'spoken')
  const main = spoken[0]
  const rest = spoken.slice(1)
  const result = emptyOrganizedIntake()
  if (main) result.chiefComplaint = { text: main.text, citations: [main.id] }
  if (rest.length) result.presentIllness = { text: rest.map(line => line.text).join('\n'), citations: rest.map(line => line.id) }
  return result
}

export function fieldsFromOrganization(organized: OrganizedIntake): Record<OrganizedIntakeKey, Field<string>> {
  return Object.fromEntries(ORGANIZED_KEYS.map(key => [key, organized[key].text === null
    ? { value: null, source: 'unknown' }
    : { value: organized[key].text, source: 'student' }])) as Record<OrganizedIntakeKey, Field<string>>
}

export function validOrganizationPair(value: unknown): value is { student: OrganizedIntake; teacher: OrganizedIntake } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const pair = value as Record<string, unknown>
  const syntheticOriginals: IntakeOriginal[] = Array.from({ length: 500 }, (_, index) => ({ id: index + 1, text: '依据', source: 'spoken' }))
  return validateOrganizedIntake(pair.student, syntheticOriginals) !== null
    && validateOrganizedIntake(pair.teacher, syntheticOriginals) !== null
}

export function replaceOrganizedText(organized: OrganizedIntake | undefined, key: OrganizedIntakeKey, text: string): OrganizedIntake {
  const next = structuredClone(organized ?? emptyOrganizedIntake())
  // 若学生手工补写的字段还没有原话引用，它属于学生本人修改，不伪造引用，也不冒充智能体整理。
  next[key] = next[key].citations.length === 0 || text.trim() === ''
    ? { text: null, citations: [] }
    : { text: text.trim(), citations: [...next[key].citations] }
  return next
}

export type { IntakeOriginal, OrganizedIntake, OrganizedIntakeField, OrganizedIntakeKey }
