import { matchCategory, redFlagDocument } from './rules'
import type { RedFlagAction, RedFlagCategory, RedFlagDocument } from './rules'
import { normalizeText } from './normalize'

export type { RedFlagAction, RedFlagCategory, RedFlagDocument } from './rules'
export { durationMinutes, matchedWords, redFlagDocument, SUPPORTED_RULES, validateDocument } from './rules'
export { COVERED_SIMPLIFIED, normalizeText, TRADITIONAL_TO_SIMPLIFIED } from './normalize'

export const redFlagCategories: RedFlagCategory[] = redFlagDocument.categories

export interface RedFlagResult {
  hit: boolean
  category: RedFlagCategory | null
  matched: string[]
  source: 'local' | 'model' | 'none'
  // 同时命中的动作类型（急症在前、自伤在后）；界面只用于常驻就医提示，不显示电话号码。
  actions: RedFlagAction[]
}

function noHit(): RedFlagResult {
  return { hit: false, category: null, matched: [], source: 'none', actions: [] }
}

// 第一层：纯本地、同步、可复现。匹配前先把繁体转简体、去掉空白，再按清单里的词匹配。
export function check(input: string, document: RedFlagDocument = redFlagDocument): RedFlagResult {
  if (typeof input !== 'string') return noHit()
  const text = normalizeText(input)
  if (text === '') return noHit()
  const matches: { category: RedFlagCategory; matched: string[] }[] = []
  for (const category of document.categories) {
    const matched = matchCategory(category, text)
    if (matched !== null) matches.push({ category, matched })
  }
  if (matches.length === 0) return noHit()
  // 同时命中急症与自伤时，类别优先自伤；actions 保留两类，界面把急救号码放前面。
  const chosen = matches.find(item => item.category.action === 'crisis') ?? matches[0]
  const actions = (['emergency', 'crisis'] as const).filter(action => matches.some(item => item.category.action === action))
  return { hit: true, category: chosen.category, matched: chosen.matched, source: 'local', actions: [...actions] }
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
export async function checkWithModel(
  input: string,
  judge?: SecondLayerJudge,
  document: RedFlagDocument = redFlagDocument,
): Promise<RedFlagResult> {
  const local = check(input, document)
  if (!judge) return local
  let verdict: SecondLayerVerdict | null | undefined
  try {
    verdict = await judge(input, local)
  } catch {
    return local
  }
  if (local.hit || !verdict?.hit) return local
  const category = document.categories.find(item => item.id === verdict.categoryId)
  if (!category) return local
  return { hit: true, category, matched: [], source: 'model', actions: [category.action] }
}
