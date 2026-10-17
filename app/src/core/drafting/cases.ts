/** M1-11 提供的本机去标识医案只读投影；不得传入完整病历或学生身份。 */
export interface DraftCase {
  id: string
  symptomSummary: string
  pattern: string
}

export function searchCases(query: string, cases: readonly DraftCase[]): DraftCase[] {
  const terms = [...new Set(query.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean))]
  if (!terms.length) return []
  return cases.map((item, index) => {
    const text = `${item.symptomSummary} ${item.pattern}`.normalize('NFKC').toLowerCase()
    return { item, index, score: terms.filter(term => text.includes(term)).length }
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3).map(({ item }) => ({ id: item.id, symptomSummary: item.symptomSummary, pattern: item.pattern }))
}
