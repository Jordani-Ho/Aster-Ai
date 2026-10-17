import { matchCategory, redFlagDocument } from './rules'
import type { EmergencyContact, RedFlagAction, RedFlagCategory, RedFlagDocument } from './rules'

export type { EmergencyContact, RedFlagAction, RedFlagCategory, RedFlagDocument } from './rules'
export { durationMinutes, matchedWords, redFlagDocument, SUPPORTED_RULES, validateDocument } from './rules'

export const redFlagCategories: RedFlagCategory[] = redFlagDocument.categories

export interface RedFlagResult {
  hit: boolean
  category: RedFlagCategory | null
  matched: string[]
  source: 'local' | 'model' | 'none'
}

function noHit(): RedFlagResult {
  return { hit: false, category: null, matched: [], source: 'none' }
}

// 第一层：纯本地、同步、可复现。不联网，不调用大模型，词表全部来自清单文件。
export function check(input: string): RedFlagResult {
  if (typeof input !== 'string' || input.trim() === '') return noHit()
  const matches: { category: RedFlagCategory; matched: string[] }[] = []
  for (const category of redFlagCategories) {
    const matched = matchCategory(category, input)
    if (matched !== null) matches.push({ category, matched })
  }
  if (matches.length === 0) return noHit()
  // 同时命中急症与自伤时，优先显示危机提示，避免把轻生信号淹没在急救提示里。
  const chosen = matches.find(item => item.category.action === 'crisis') ?? matches[0]
  return { hit: true, category: chosen.category, matched: chosen.matched, source: 'local' }
}

export interface SecondLayerVerdict {
  hit: boolean
  categoryId?: string
}

export type SecondLayerJudge = (
  input: string,
  layerOne: RedFlagResult,
) => Promise<SecondLayerVerdict | null | undefined> | SecondLayerVerdict | null | undefined

// 第二层：可选的大模型复核。只允许“增加命中”，第一层命中无论如何都保留；
// 模型返回清单里没有的类别时不采纳，模型抛错也不影响第一层结果。
export async function checkWithModel(input: string, judge?: SecondLayerJudge): Promise<RedFlagResult> {
  const local = check(input)
  if (!judge) return local
  let verdict: SecondLayerVerdict | null | undefined
  try {
    verdict = await judge(input, local)
  } catch {
    return local
  }
  if (local.hit || !verdict?.hit) return local
  const category = redFlagCategories.find(item => item.id === verdict.categoryId)
  if (!category) return local
  return { hit: true, category, matched: [], source: 'model' }
}

// 把浏览器语言标签映射成清单里的地区代码；识别不出时返回 null，界面显示通用提示。
export function detectRegion(locale?: string | null): string | null {
  const tag = String(locale ?? '').trim().toLowerCase().replace(/_/g, '-')
  if (tag === '') return null
  if (tag.startsWith('zh-tw') || tag.startsWith('zh-hant-tw')) return 'TW'
  if (tag.startsWith('zh-hk') || tag.startsWith('zh-mo')) return 'HK'
  if (tag.startsWith('zh')) return 'CN'
  if (tag.startsWith('en-sg')) return 'SG'
  if (tag.startsWith('en-us')) return 'US'
  return null
}

// 只返回清单里 verified 为 true 的号码；未核实或地区未知时返回 null，界面不得编造号码。
export function getContact(
  region: string | null | undefined,
  action: RedFlagAction,
  document: RedFlagDocument = redFlagDocument,
): EmergencyContact | null {
  if (region === null || region === undefined) return null
  const key = String(region).trim().toUpperCase()
  const entry = document.contacts[key]
  if (!entry) return null
  const contact = entry[action]
  return contact && contact.verified ? contact : null
}
