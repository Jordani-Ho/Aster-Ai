import { validOriginals } from '../intake/organization'
import type { IntakeOriginal, OrganizedIntakeField } from './types'
export const VISIT_ORGANIZATION_KEYS = ['chiefComplaint', 'presentIllness', 'look', 'listenSmell', 'ask', 'pulse'] as const
export type VisitOrganizationKey = (typeof VISIT_ORGANIZATION_KEYS)[number]
export type VisitOrganization = Record<VisitOrganizationKey, OrganizedIntakeField>
export function emptyVisitOrganization(): VisitOrganization {
  return { chiefComplaint:{text:null,citations:[]}, presentIllness:{text:null,citations:[]}, look:{text:null,citations:[]}, listenSmell:{text:null,citations:[]}, ask:{text:null,citations:[]}, pulse:{text:null,citations:[]} }
}
/** 校验每栏与原话序号；实际语义需由老师核对。 */
export function validateVisitOrganization(value: unknown, originals: readonly IntakeOriginal[]): VisitOrganization | null {
  if (!validOriginals(originals) || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>, keys = Object.keys(raw)
  if (keys.length !== VISIT_ORGANIZATION_KEYS.length || keys.some(key => !VISIT_ORGANIZATION_KEYS.includes(key as VisitOrganizationKey))) return null
  const ids = new Set(originals.map(item => item.id)), result = emptyVisitOrganization()
  for (const key of VISIT_ORGANIZATION_KEYS) {
    const value = raw[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const field = value as Record<string, unknown>, text = field.text, citations = field.citations
    if (Object.keys(field).some(item => item !== 'text' && item !== 'citations')) return null
    if (text !== null && (typeof text !== 'string' || !text.trim() || text.length > 2000)) return null
    if (!Array.isArray(citations) || citations.length > 100 || citations.some(id => !Number.isSafeInteger(id) || !ids.has(id)) || new Set(citations).size !== citations.length) return null
    if ((text === null) !== (citations.length === 0)) return null
    result[key] = { text: text as string | null, citations: [...citations] as number[] }
  }
  return result
}
/** 老师改过的栏不再被后续自动整理覆盖。 */
export function mergeVisitOrganization(prior: VisitOrganization, next: VisitOrganization, edited: readonly VisitOrganizationKey[]): VisitOrganization {
  const result = structuredClone(prior)
  for (const key of VISIT_ORGANIZATION_KEYS) {
    if (edited.includes(key) || next[key].text === null) continue
    result[key] = { text: [prior[key].text, next[key].text].filter(Boolean).join('\n'), citations: [...new Set([...prior[key].citations, ...next[key].citations])] }
  }
  return result
}
