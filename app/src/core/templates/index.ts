import type { LocalStore, StoreValue } from '../store'
import initial from '../../../../domain/tcm/templates/default.json'
import { defaultSchema, validateSchema, TEMPLATE_TYPES, type TemplateType, type TemplateSchema } from '../../../../domain/tcm/templates/schema'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'

type TemplateStore = Pick<LocalStore, 'get' | 'put'>
export interface TemplateVersion { id: string; type: TemplateType; name: string; version: number; parentId: string | null; status: 'draft' | 'active' | 'archived'; schema: TemplateSchema }
export const TEMPLATES_KEY = 'teacher-templates'
let queue: Promise<void> = Promise.resolve()
const idValid = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)
export async function loadTemplates(store: Pick<LocalStore, 'get'>): Promise<TemplateVersion[]> {
  const value = await store.get('settings', TEMPLATES_KEY)
  if (value === undefined) return []
  const rows = value && typeof value === 'object' ? (value as { rows?: unknown }).rows : undefined
  if (!Array.isArray(rows)) throw Error('模板版本记录无效')
  const ids = new Set<string>(), active = new Set<string>()
  for (const row of rows) {
    if (!row || !idValid(row.id) || ids.has(row.id) || !TEMPLATE_TYPES.includes(row.type) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 100 || !Number.isSafeInteger(row.version) || row.version < 1 || !['draft', 'active', 'archived'].includes(row.status) || row.parentId !== null && !idValid(row.parentId)) throw Error('模板版本记录无效')
    ids.add(row.id)
    validateSchema(row.type, row.schema, row.status === 'active')
    if (row.status === 'active') { if (active.has(row.type)) throw Error('同类生效模板重复'); active.add(row.type) }
  }
  for (const row of rows) if (row.parentId !== null && !rows.some(parent => parent.id === row.parentId && parent.type === row.type && parent.version < row.version)) throw Error('模板版本链无效')
  return structuredClone(rows)
}
function mutate<T>(store: TemplateStore, change: (rows: TemplateVersion[]) => T): Promise<T> {
  const action = async () => {
    const rows = await loadTemplates(store)
    const result = change(rows)
    try { await store.put('settings', TEMPLATES_KEY, { rows } as unknown as StoreValue) }
    catch (cause) { throw Error(`没保存成功：${cause instanceof Error ? cause.message : '本机存储不可用'}`) }
    return structuredClone(result)
  }
  const result = queue.then(() => globalThis.navigator?.locks ? navigator.locks.request('aster-templates', action) : action())
  queue = result.then(() => {}, () => {})
  return result
}
export function saveTemplateDraft(store: TemplateStore, type: TemplateType, name: string, schema: unknown, parentId?: string): Promise<TemplateVersion> {
  if (!TEMPLATE_TYPES.includes(type) || typeof name !== 'string' || !name.trim() || name.length > 100 || parentId !== undefined && !idValid(parentId)) return Promise.reject(Error('模板名称或版本无效'))
  const clean = validateSchema(type, schema)
  return mutate(store, rows => {
    const parent = parentId ? rows.find(row => row.id === parentId && row.type === type) : undefined
    if (parentId && !parent) throw Error('模板父版本不存在或不属于此类')
    const existing = rows.find(row => row.type === type && row.status === 'draft')
    if (existing) { existing.name = name.trim(); existing.schema = clean; return existing }
    const active = parent ?? rows.find(row => row.type === type && row.status === 'active')
    const next: TemplateVersion = { id: crypto.randomUUID(), type, name: name.trim(), version: Math.max(0, ...rows.filter(row => row.type === type).map(row => row.version)) + 1, parentId: active?.id ?? null, status: 'draft', schema: clean }
    rows.push(next)
    return next
  })
}
export function publishTemplate(store: TemplateStore, id: string): Promise<TemplateVersion> {
  if (!idValid(id)) return Promise.reject(Error('模板版本无效'))
  return mutate(store, rows => {
    const row = rows.find(item => item.id === id)
    if (!row) throw Error('找不到模板')
    if (row.status === 'active') return row
    if (row.status !== 'draft') throw Error('已归档模板须派生新版再发布')
    validateSchema(row.type, row.schema, true)
    for (const prior of rows) if (prior.type === row.type && prior.status === 'active') prior.status = 'archived'
    row.status = 'active'
    return row
  })
}
/** 同一模板库投影给既有起草器，不再保存另一份病历顺序设置。 */
export async function templateForDrafting(store: Pick<LocalStore, 'get'>): Promise<TeacherTemplate> {
  const rows = await loadTemplates(store), active = rows.filter(row => row.status === 'active')
  if (!active.length) {
    const prior = await store.get('settings', 'teacher-template')
    if (prior === undefined) return structuredClone(initial)
    const legacy = prior as unknown as TeacherTemplate
    if (!legacy || typeof legacy.name !== 'string' || !legacy.name.trim() || legacy.name.length > 100 || typeof legacy.notes !== 'string' || legacy.notes.length > 4000 || !Array.isArray(legacy.focus) || !legacy.focus.length || legacy.focus.length > 30 || legacy.focus.some(item => typeof item !== 'string' || !item.trim() || item.length > 100) || !Array.isArray(legacy.recordOrder) || !legacy.recordOrder.length) throw Error('原模板无效，请在四类模板中重新发布')
    return { id: initial.id, name: legacy.name.trim(), notes: legacy.notes, focus: legacy.focus.map(item => item.trim()), recordOrder: [...initial.recordOrder] }
  }
  const workflow = Object.fromEntries(TEMPLATE_TYPES.map(type => [type, active.find(row => row.type === type)?.schema ?? defaultSchema(type)])) as Record<TemplateType, TemplateSchema>
  const record = active.find(row => row.type === 'record')
  const order = [...workflow.record.sections].sort((a, b) => a.order - b.order).flatMap(section => initial.recordOrder.filter(path => path.startsWith((section.key === 'four_exams' ? 'fourExams' : section.key) + '.')))
  return { id: record?.id ?? initial.id, name: record?.name ?? initial.name,
    focus: [...workflow.inquiry.fields].sort((a, b) => a.order - b.order).map(item => item.label),
    recordOrder: order.length ? order : [...initial.recordOrder], notes: workflow.record.tone?.style ?? '', workflow }
}
