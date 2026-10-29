import type { LocalStore, StoreValue } from '../store'
import type { IntakeOriginal } from './types'
import { validOriginals } from '../intake/organization'
export const VISIT_ORIGINALS = 'visit-originals'
export interface VisitOriginal extends IntakeOriginal { edited: boolean }
function assertId(id: string): void { if (!/^[0-9a-f]{32}$/.test(id)) throw Error('面诊编号无效') }
function assertText(text: string): void { if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw Error('原话不能为空或超过 2000 字') }
function parse(value: unknown): VisitOriginal[] {
  if (value === undefined) return []
  if (!validOriginals(value) || value.some(row => typeof (row as VisitOriginal).edited !== 'boolean')) throw Error('面诊原话读取失败')
  return value as VisitOriginal[]
}
export async function loadVisitOriginals(store: LocalStore, id: string): Promise<VisitOriginal[]> {
  assertId(id); return parse(await store.get(VISIT_ORIGINALS, id))
}
export async function appendVisitOriginal(store: LocalStore, id: string, text: string): Promise<VisitOriginal> {
  assertId(id); assertText(text)
  return store.atomic(async tx => {
    const rows = parse(await tx.get(VISIT_ORIGINALS, id))
    if (rows.length >= 500) throw Error('面诊原话最多 500 句')
    const next: VisitOriginal = { id: rows.length + 1, text, source:'spoken', edited:false }
    tx.put(VISIT_ORIGINALS, id, [...rows, next] as unknown as StoreValue)
    return next
  })
}
export async function editVisitOriginal(store: LocalStore, id: string, line: number, text: string): Promise<void> {
  assertId(id); assertText(text)
  if (!Number.isSafeInteger(line) || line <= 0) throw Error('原话序号无效')
  await store.atomic(async tx => {
    const rows = parse(await tx.get(VISIT_ORIGINALS, id))
    if (!rows[line - 1] || rows[line - 1].id !== line) throw Error('原话不存在')
    rows[line - 1] = { ...rows[line - 1], text, edited:true }
    tx.put(VISIT_ORIGINALS, id, rows as unknown as StoreValue)
  })
}
