/** M1-11 提供的本机去标识医案只读投影；不得传入完整病历或学生身份。 */
export interface DraftCase {
  id: string
  symptomSummary: string
  pattern: string
}

export function searchCases(query: string, cases: readonly DraftCase[]): DraftCase[] {
  const terms = bigrams(query)
  if (!terms.length) return []
  return cases.map((item, index) => {
    const grams = new Set(bigrams(`${item.symptomSummary} ${item.pattern}`))
    return { item, index, score: terms.filter(term => grams.has(term)).length }
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : a.index - b.index))
    .slice(0, 3).map(({ item }) => ({ id: item.id, symptomSummary: item.symptomSummary, pattern: item.pattern }))
}

function bigrams(value: string): string[] {
  // 标点、空白及其他非汉字均为边界，不跨短句拼接。
  const runs = value.normalize('NFKC').match(/\p{Script=Han}+/gu) ?? []
  return [...new Set(runs.flatMap(run => {
    const chars = Array.from(run)
    return chars.slice(1).map((char, index) => chars[index] + char)
  }))]
}
