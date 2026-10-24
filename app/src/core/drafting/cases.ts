/**
 * V2-19：本机医案只读投影。只放老师亲手写过（不是 ai_accepted）的内容，
 * 不得传入完整病历或学生身份。
 */
export interface DraftCase {
  id: string
  symptomSummary: string
  pattern: string
  /** 老师亲手改方时写下的加减理由；只有改过的医案才有。 */
  changeReason?: string
  /** 老师亲手改过的方子，只作参考，不是本次处方。 */
  prescription?: { items: { herb: string; dose: string }[]; method?: string; days?: number }
}

export function searchCases(query: string, cases: readonly DraftCase[]): DraftCase[] {
  const terms = bigrams(query)
  if (!terms.length) return []
  return cases.map((item, index) => {
    const grams = new Set(bigrams(`${item.symptomSummary} ${item.pattern} ${item.changeReason ?? ''}`))
    return { item, index, score: terms.filter(term => grams.has(term)).length }
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : a.index - b.index))
    .slice(0, 3).map(({ item }) => ({ ...item }))
}

function bigrams(value: string): string[] {
  // 标点、空白及其他非汉字均为边界，不跨短句拼接。
  const runs = value.normalize('NFKC').match(/\p{Script=Han}+/gu) ?? []
  return [...new Set(runs.flatMap(run => {
    const chars = Array.from(run)
    return chars.slice(1).map((char, index) => chars[index] + char)
  }))]
}
