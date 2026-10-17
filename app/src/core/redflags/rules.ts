import redFlagsJson from '../../../../domain/tcm/red-flags.json'

export type RedFlagAction = 'emergency' | 'crisis'

export interface RedFlagCategory {
  id: string
  name: string
  action: RedFlagAction
  keywords: string[]
  aggravators?: string[]
  rule: string
}

export interface EmergencyContact {
  number: string
  name?: string
  verified: boolean
  checked: string
  source: string
}

export interface RegionContacts {
  emergency?: EmergencyContact
  crisis?: EmergencyContact
}

export interface RedFlagDocument {
  version: number
  policy?: string
  categories: RedFlagCategory[]
  contacts: Record<string, RegionContacts>
}

// 引擎只实现清单里实际出现的两种规则。新增规则必须先改代码并过测试，不允许静默忽略。
export const SUPPORTED_RULES = ['any keyword', 'keyword AND (aggravator OR duration>=15min)'] as const
const RULE_ANY = 'any keyword'
const RULE_COMBINATION = 'keyword AND (aggravator OR duration>=15min)'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('红线清单字段无效：' + label)
  return value
}

function parseContact(value: unknown, label: string): EmergencyContact {
  if (!isRecord(value)) throw new Error('红线清单联系方式无效：' + label)
  const number = requiredText(value.number, label + '.number')
  if (!/^\d{3,5}$/.test(number)) throw new Error('红线清单联系电话格式无效：' + label)
  if (typeof value.verified !== 'boolean') throw new Error('红线清单联系方式缺少 verified：' + label)
  if (value.verified) {
    requiredText(value.checked, label + '.checked')
    if (!/^https:\/\//.test(requiredText(value.source, label + '.source'))) throw new Error('红线清单联系方式来源无效：' + label)
  }
  const contact: EmergencyContact = {
    number,
    verified: value.verified,
    checked: typeof value.checked === 'string' ? value.checked : '',
    source: typeof value.source === 'string' ? value.source : '',
  }
  if (typeof value.name === 'string' && value.name.trim() !== '') contact.name = value.name
  return contact
}

export function validateDocument(input: unknown): RedFlagDocument {
  if (!isRecord(input)) throw new Error('红线清单格式无效')
  if (typeof input.version !== 'number') throw new Error('红线清单缺少版本号')
  if (!Array.isArray(input.categories) || input.categories.length === 0) throw new Error('红线清单没有类别')
  if (!isRecord(input.contacts)) throw new Error('红线清单缺少联系方式')
  const ids = new Set<string>()
  const categories = input.categories.map((entry, index): RedFlagCategory => {
    if (!isRecord(entry)) throw new Error('红线类别格式无效：第 ' + (index + 1) + ' 项')
    const id = requiredText(entry.id, 'categories.id')
    if (!/^RF-\d{2}$/.test(id)) throw new Error('红线类别 id 格式无效：' + id)
    if (ids.has(id)) throw new Error('红线类别 id 重复：' + id)
    ids.add(id)
    if (entry.action !== 'emergency' && entry.action !== 'crisis') throw new Error('红线类别 action 无效：' + id)
    if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) throw new Error('红线类别没有关键词：' + id)
    const keywords = entry.keywords.map((word, position) => requiredText(word, id + '.keywords[' + position + ']'))
    const rule = requiredText(entry.rule, id + '.rule')
    if (!(SUPPORTED_RULES as readonly string[]).includes(rule)) throw new Error('红线类别规则未实现：' + id + ' -> ' + rule)
    const category: RedFlagCategory = { id, name: requiredText(entry.name, id + '.name'), action: entry.action, keywords, rule }
    if (entry.aggravators !== undefined) {
      if (!Array.isArray(entry.aggravators) || entry.aggravators.length === 0) throw new Error('红线类别加重因素无效：' + id)
      category.aggravators = entry.aggravators.map((word, position) => requiredText(word, id + '.aggravators[' + position + ']'))
    }
    return category
  })
  const contacts: Record<string, RegionContacts> = {}
  for (const [region, value] of Object.entries(input.contacts)) {
    if (region.startsWith('_')) continue
    if (!/^[A-Z]{2}$/.test(region)) throw new Error('红线清单地区代码无效：' + region)
    if (!isRecord(value)) throw new Error('红线清单地区联系方式无效：' + region)
    const entry: RegionContacts = {}
    for (const action of ['emergency', 'crisis'] as const) {
      if (value[action] !== undefined) entry[action] = parseContact(value[action], region + '.' + action)
    }
    contacts[region] = entry
  }
  return { version: input.version, ...(typeof input.policy === 'string' ? { policy: input.policy } : {}), categories, contacts }
}

export function matchedWords(input: string, words: string[] | undefined): string[] {
  return (words ?? []).filter(word => input.includes(word))
}

const chineseDigits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

function chineseNumber(value: string): number | null {
  if (value === '十') return 10
  const ten = value.indexOf('十')
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : chineseDigits[value.slice(0, ten)]
    const ones = ten === value.length - 1 ? 0 : chineseDigits[value.slice(ten + 1)]
    return tens === undefined || ones === undefined ? null : tens * 10 + ones
  }
  return value.length === 1 ? chineseDigits[value] ?? null : null
}

// 从口语里提取“持续了多久”。只认明确的数字或中文数字，判断不出来时返回 null。
export function durationMinutes(input: string): number | null {
  let minutes: number | null = null
  const remember = (value: number) => {
    if (Number.isFinite(value) && (minutes === null || value > minutes)) minutes = value
  }
  for (const found of input.matchAll(/(\d+(?:\.\d+)?)\s*(?:个)?\s*多?\s*(小时|钟头)/g)) remember(Number(found[1]) * 60)
  for (const found of input.matchAll(/(\d+)\s*多?\s*(分钟|分)/g)) remember(Number(found[1]))
  for (const found of input.matchAll(/([一二两三四五六七八九十]+)\s*(?:个)?\s*多?\s*(小时|钟头)/g)) {
    const value = chineseNumber(found[1])
    if (value !== null) remember(value * 60)
  }
  for (const found of input.matchAll(/([一二两三四五六七八九十]+)\s*多?\s*(分钟|分)/g)) {
    const value = chineseNumber(found[1])
    if (value !== null) remember(value)
  }
  if (/半\s*(?:个)?\s*(?:小时|钟头)/.test(input)) remember(30)
  if (/一刻钟/.test(input)) remember(15)
  return minutes
}

export function matchCategory(category: RedFlagCategory, input: string): string[] | null {
  const keywords = matchedWords(input, category.keywords)
  if (keywords.length === 0) return null
  if (category.rule === RULE_ANY) return keywords
  if (category.rule === RULE_COMBINATION) {
    const aggravators = matchedWords(input, category.aggravators)
    const minutes = durationMinutes(input)
    if (aggravators.length === 0 && (minutes === null || minutes < 15)) return null
    return [...keywords, ...aggravators]
  }
  throw new Error('未实现的规则：' + category.rule)
}

export const redFlagDocument: RedFlagDocument = validateDocument(redFlagsJson)
