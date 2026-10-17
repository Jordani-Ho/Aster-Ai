import type { LocalStore } from '../store'
import type { Encounter, Field } from '../record/types'
import { modificationLog, pendingDraftFields } from '../record/sign'
export interface PilotMetric { idPrefix: string; durationMs: number; modificationRate: number; missingRate: number; resemblance: number | null }
// Adoption metadata changes provenance, not the content being measured.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'source' && key !== 'note').sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
export function calculateMetric(draft: Encounter, final: Encounter, startedAt: number, signedAt: number): PilotMetric {
  if (!Number.isFinite(startedAt) || !Number.isFinite(signedAt)) throw Error('指标时间无效')
  const fields = [...Object.values(final.intake).filter((value): value is Field<string> => !Array.isArray(value)), ...Object.values(final.fourExams)]
  const missing = fields.filter(field => field.source === 'unknown' || field.value === null).length
  const denominator = pendingDraftFields(draft).length
  const changed = modificationLog(draft, final).filter(row => JSON.stringify(canonical(row.aiDraft)) !== JSON.stringify(canonical(row.final))).length
  return validate({ idPrefix: final.id.slice(0, 8), durationMs: Math.max(0, Math.round(signedAt - startedAt)), modificationRate: denominator ? changed / denominator : 0, missingRate: missing / fields.length, resemblance: null })
}
function validate(value: PilotMetric): PilotMetric {
  if (!value || !/^[0-9a-f]{8}$/.test(value.idPrefix) || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 ||
    ![value.modificationRate, value.missingRate].every(n => Number.isFinite(n) && n >= 0 && n <= 1) ||
    !(value.resemblance === null || Number.isInteger(value.resemblance) && value.resemblance >= 1 && value.resemblance <= 5)) throw Error('试点指标格式无效')
  return { idPrefix: value.idPrefix, durationMs: value.durationMs, modificationRate: value.modificationRate, missingRate: value.missingRate, resemblance: value.resemblance }
}
export async function saveMetric(store: LocalStore, key: string, value: PilotMetric) { await store.put('pilot-metrics', key, { ...validate(value) }) }
export async function rateMetric(store: LocalStore, key: string, score: number) {
  const value = await store.get('pilot-metrics', key) as unknown as PilotMetric | undefined
  if (!value) throw Error('未找到试点指标')
  await saveMetric(store, key, { ...value, resemblance: score })
}
export async function exportMetrics(store: LocalStore): Promise<string> {
  const values = (await store.list('pilot-metrics')).map(row => validate(row.value as unknown as PilotMetric))
  return 'record_id_prefix,draft_to_sign_ms,modification_rate,missing_rate,resemblance\r\n' + values.map(v => [v.idPrefix, v.durationMs, v.modificationRate, v.missingRate, v.resemblance ?? ''].join(',') + '\r\n').join('')
}
