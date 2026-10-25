import type { LocalStore, StoreValue } from '../store'
import herbUnitDefaults from '../../../../domain/tcm/herb-units.json'

export const HERB_UNITS = ['克', '钱', '两', '片', '枚', '个'] as const
export type HerbUnit = typeof HERB_UNITS[number]
export type HerbReason = '入库' | '开方扣减' | '盘点调整' | '作废冲回'
export interface Herb { id: string; name: string; normalizedName: string; unit: HerbUnit; quantity: number; threshold: number; enabled: boolean; createdAt: string }
export interface HerbLedger { id: string; herb: string; delta: number; reason: HerbReason; ref: string; at: string; balanceAfter: number; key: string }
export interface HerbUnits { qianInTenthsGram: number | null; liangInTenthsGram: number | null }
export interface HerbStore extends Pick<LocalStore, 'get' | 'list' | 'put' | 'atomic'> {}
export const DEFAULT_HERB_UNITS: HerbUnits = herbUnitDefaults
export interface PrescriptionLine { herb: string; quantity: number; unit: HerbUnit }
export interface LegacySharedHomeHerb { name: string; status: '够' | '快没了' }
export interface SharedHomeHerbSnapshot { name: string; quantity: number; unit: HerbUnit }
export type SharedHomeHerb = LegacySharedHomeHerb | SharedHomeHerbSnapshot
export const HERBS = 'herbs'
export const HERB_LEDGER = 'herb-ledger'
export const HERB_SETTINGS = 'herb-settings'
const ID = /^[A-Za-z0-9_-]{1,64}$/
const MASS_UNITS: HerbUnit[] = ['克', '钱', '两']

export function normalizeHerbName(name: unknown): string {
  if (typeof name !== 'string') throw Error('药材名称无效')
  const normalized = name.normalize('NFKC').replace(/\s/gu, '')
  if (!normalized || normalized.length > 40) throw Error('药材名称须为 1–40 个字')
  return normalized
}
export function validateHerbUnit(unit: unknown): asserts unit is HerbUnit {
  if (!HERB_UNITS.includes(unit as HerbUnit)) throw Error('单位不在药材单位范围内')
}
export function validateHerbAmount(quantity: unknown, unit: HerbUnit, threshold = false): number {
  validateHerbUnit(unit)
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0 || (!threshold && quantity === 0)) throw Error(threshold ? '警戒线不能小于 0' : '数量必须大于 0')
  if (threshold && quantity === 0) return 0
  const scale = MASS_UNITS.includes(unit) ? 10 : 1
  const smallest = quantity * scale
  if (!Number.isSafeInteger(smallest)) throw Error('数量最多精确到 0.1 克或整数份')
  if (unit === '克' && smallest > 1_000_000 || unit !== '克' && MASS_UNITS.includes(unit) && quantity > 100_000) throw Error('单味单次入库不能超过 100 千克')
  return smallest
}
export function validateHerbUnits(value: unknown): HerbUnits {
  if (!value || typeof value !== 'object') throw Error('药材换算配置无效')
  const units = value as HerbUnits
  for (const key of ['qianInTenthsGram', 'liangInTenthsGram'] as const) {
    const amount = units[key]
    if (amount !== null && (!Number.isSafeInteger(amount) || amount <= 0)) throw Error('钱、两换算须为正整数个 0.1 克')
  }
  return { qianInTenthsGram: units.qianInTenthsGram, liangInTenthsGram: units.liangInTenthsGram }
}
export function toSmallestUnit(quantity: number, unit: HerbUnit, config: HerbUnits): number {
  validateHerbUnit(unit)
  if (!Number.isFinite(quantity) || quantity <= 0) throw Error('数量必须大于 0')
  if (unit === '克') return validateHerbAmount(quantity, unit)
  if (unit === '片' || unit === '枚' || unit === '个') return validateHerbAmount(quantity, unit)
  const factor = unit === '钱' ? config.qianInTenthsGram : config.liangInTenthsGram
  if (!factor) throw Error(`请先在设置中确认 1${unit}折合多少克`)
  const result = quantity * factor
  if (!Number.isSafeInteger(result)) throw Error('换算后的数量不能精确到 0.1 克')
  if (result > 1_000_000) throw Error('单味单次入库不能超过 100 千克')
  return result
}
function asHerb(value: unknown): Herb {
  const herb = value as Herb
  if (!herb || !ID.test(herb.id) || normalizeHerbName(herb.name) !== herb.normalizedName || !HERB_UNITS.includes(herb.unit)
    || !Number.isSafeInteger(herb.quantity) || herb.quantity < 0 || !Number.isSafeInteger(herb.threshold) || herb.threshold < 0 || typeof herb.enabled !== 'boolean') throw Error('药材记录无效')
  return herb
}
function asLedger(value: unknown): HerbLedger {
  const row = value as HerbLedger
  if (!row || !ID.test(row.id) || !ID.test(row.herb) || !Number.isSafeInteger(row.delta) || row.delta === 0 || !['入库', '开方扣减', '盘点调整', '作废冲回'].includes(row.reason) || !row.ref || !row.key) throw Error('药材流水无效')
  return row
}
function randomId(): string { return crypto.randomUUID().replaceAll('-', '') }

export async function listHerbs(store: Pick<HerbStore, 'list'>): Promise<Herb[]> {
  return (await store.list(HERBS)).map(row => asHerb(row.value)).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}
export async function listHerbLedger(store: Pick<HerbStore, 'list'>): Promise<HerbLedger[]> {
  return (await store.list(HERB_LEDGER)).map(row => asLedger(row.value)).sort((a, b) => b.at.localeCompare(a.at))
}
export async function createHerb(store: Pick<HerbStore, 'atomic'>, input: { name: string; unit: HerbUnit; threshold: number; id?: string; at?: string }, units: HerbUnits = DEFAULT_HERB_UNITS): Promise<Herb> {
  const normalizedName = normalizeHerbName(input.name); validateHerbUnit(input.unit)
  validateHerbAmount(input.threshold, input.unit, true)
  const threshold = input.threshold === 0 ? 0 : toSmallestUnit(input.threshold, input.unit, validateHerbUnits(units))
  const id = input.id ?? randomId(); if (!ID.test(id)) throw Error('药材编号无效')
  const herb: Herb = { id, name: input.name.trim(), normalizedName, unit: input.unit, quantity: 0, threshold, enabled: true, createdAt: input.at ?? new Date().toISOString() }
  return store.atomic(async tx => {
    const existing = await tx.list(HERBS)
    if (existing.some(row => asHerb(row.value).normalizedName === normalizedName)) throw Error('同名药材已经在库中')
    tx.put(HERBS, id, herb as unknown as StoreValue)
    return herb
  })
}
async function changeBalance(store: Pick<HerbStore, 'atomic'>, herbId: string, amount: number | ((herb: Herb) => number), reason: HerbReason, ref: string, key: string, at = new Date()): Promise<HerbLedger | null> {
  if (!ID.test(herbId) || !ref.trim() || !key.trim() || key.length > 120) throw Error('药材流水输入无效')
  return store.atomic(async tx => {
    const rows = await tx.list(HERB_LEDGER)
    const duplicate = rows.map(row => asLedger(row.value)).find(row => row.key === key)
    if (duplicate) return null
    const current = await tx.get(HERBS, herbId)
    if (!current) throw Error('药材不存在')
    const herb = asHerb(current)
    if (!herb.enabled) throw Error('药材已停用，请先启用')
    const delta = typeof amount === 'function' ? amount(herb) : amount
    if (!Number.isSafeInteger(delta) || delta === 0) throw Error('药材流水输入无效')
    const next = herb.quantity + delta
    if (next < 0) throw Error('库存不足')
    herb.quantity = next
    const entry: HerbLedger = { id: randomId(), herb: herbId, delta, reason, ref, at: at.toISOString(), balanceAfter: next, key }
    tx.put(HERBS, herbId, herb as unknown as StoreValue)
    tx.put(HERB_LEDGER, entry.id, entry as unknown as StoreValue)
    return entry
  })
}
export async function receiveHerb(store: Pick<HerbStore, 'atomic'>, herbId: string, quantity: number, units: HerbUnits, ref: string, key: string, at?: Date): Promise<HerbLedger | null> {
  const config = validateHerbUnits(units)
  return changeBalance(store, herbId, herb => toSmallestUnit(quantity, herb.unit, config), '入库', ref, key, at)
}
export async function adjustHerb(store: Pick<HerbStore, 'atomic'>, herbId: string, delta: number, reason: string, key: string, at?: Date): Promise<HerbLedger | null> {
  if (!reason.trim()) throw Error('盘点调整要写明原因')
  return changeBalance(store, herbId, delta, '盘点调整', reason.trim(), key, at)
}
export async function setHerbEnabled(store: Pick<HerbStore, 'atomic'>, herbId: string, enabled: boolean): Promise<void> {
  if (!ID.test(herbId) || typeof enabled !== 'boolean') throw Error('药材状态无效')
  await store.atomic(async tx => {
    const value = await tx.get(HERBS, herbId); if (!value) throw Error('药材不存在')
    const herb = asHerb(value); herb.enabled = enabled; tx.put(HERBS, herbId, herb as unknown as StoreValue)
  })
}
export async function deleteHerb(store: Pick<HerbStore, 'atomic'>, herbId: string): Promise<void> {
  if (!ID.test(herbId)) throw Error('药材编号无效')
  await store.atomic(async tx => {
    const value = await tx.get(HERBS, herbId); if (!value) return
    const herb = asHerb(value)
    const history = (await tx.list(HERB_LEDGER)).some(row => asLedger(row.value).herb === herbId)
    if (history) throw Error('有过流水的药材不能删除，请停用')
    if (herb.quantity !== 0) throw Error('库存不为零的药材不能删除')
    tx.delete(HERBS, herbId)
  })
}
export async function saveHerbUnits(store: Pick<HerbStore, 'put'>, units: unknown): Promise<HerbUnits> {
  const valid = validateHerbUnits(units); await store.put(HERB_SETTINGS, 'units', valid as unknown as StoreValue); return valid
}
export async function loadHerbUnits(store: Pick<HerbStore, 'get'>): Promise<HerbUnits> {
  const value = await store.get(HERB_SETTINGS, 'units')
  return value === undefined ? validateHerbUnits(DEFAULT_HERB_UNITS) : validateHerbUnits(value)
}
export async function deductPrescription(store: Pick<HerbStore, 'atomic'>, lines: PrescriptionLine[], ref: string, key: string, options: { at?: Date; units?: HerbUnits } = {}): Promise<{ entries: HerbLedger[]; shortages: { herb: string; missing: number; unit: HerbUnit }[] }> {
  if (!Array.isArray(lines) || !lines.length || !ref.trim() || !key.trim()) throw Error('方子和流水编号无效')
  const at = options.at ?? new Date(), units = validateHerbUnits(options.units ?? DEFAULT_HERB_UNITS)
  lines.forEach(line => { normalizeHerbName(line.herb); validateHerbAmount(line.quantity, line.unit) })
  return store.atomic(async tx => {
    const old = (await tx.list(HERB_LEDGER)).map(row => asLedger(row.value))
    if (old.some(row => row.key === key)) return { entries: [], shortages: [] }
    const grouped = new Map<string, { herb: Herb; amount: number }>()
    const herbs = (await tx.list(HERBS)).map(row => asHerb(row.value))
    for (const line of lines) {
      const name = normalizeHerbName(line.herb)
      const herb = herbs.find(row => row.normalizedName === name)
      if (!herb) {
        const amount = line.quantity
        const keyForMissing = `missing:${name}`
        const previous = grouped.get(keyForMissing)
        if (previous && previous.herb.unit !== line.unit) throw Error(`${name}在方子里用了不同单位`)
        grouped.set(keyForMissing, { herb: { id: keyForMissing, name, normalizedName: name, unit: line.unit, quantity: 0, threshold: 0, enabled: true, createdAt: at.toISOString() }, amount: (previous?.amount ?? 0) + amount }); continue
      }
      if (!herb.enabled) throw Error(`${herb.name}已停用，请先启用`)
      if (herb.unit !== line.unit) throw Error(`${herb.name}的单位与方子不一致`)
      const amount = toSmallestUnit(line.quantity, herb.unit, units)
      const previous = grouped.get(herb.id); grouped.set(herb.id, { herb, amount: (previous?.amount ?? 0) + amount })
    }
    const shortages: { herb: string; missing: number; unit: HerbUnit }[] = []
    for (const { herb, amount } of grouped.values()) {
      if (herb.id.startsWith('missing:')) shortages.push({ herb: herb.name, missing: amount, unit: herb.unit })
      else if (amount > herb.quantity) shortages.push({ herb: herb.name, missing: fromSmallestUnit(amount - herb.quantity, herb.unit, units), unit: herb.unit })
    }
    if (shortages.length) return { entries: [], shortages }
    const entries: HerbLedger[] = []
    for (const [id, { herb, amount }] of grouped) {
      const updated = { ...herb, quantity: herb.quantity - amount }
      const entry: HerbLedger = { id: randomId(), herb: id, delta: -amount, reason: '开方扣减', ref, at: at.toISOString(), balanceAfter: updated.quantity, key }
      tx.put(HERBS, id, updated as unknown as StoreValue); tx.put(HERB_LEDGER, entry.id, entry as unknown as StoreValue); entries.push(entry)
    }
    return { entries, shortages: [] }
  })
}
export async function lowStockHerbs(store: Pick<HerbStore, 'list'>): Promise<Herb[]> {
  return (await listHerbs(store)).filter(herb => herb.enabled && herb.quantity <= herb.threshold)
}
export async function prescriptionStockNotes(store: Pick<HerbStore, 'list' | 'get'>, lines: (PrescriptionLine | { herb: string; dose: string })[]): Promise<string[]> {
  const [herbs, units] = await Promise.all([listHerbs(store), loadHerbUnits(store)])
  const combined = new Map<string, PrescriptionLine>()
  const notes: string[] = []
  for (const item of lines) {
    let raw: PrescriptionLine
    try { raw = 'dose' in item ? parsePrescriptionDose(item.herb, item.dose) : item }
    catch (cause) { notes.push(cause instanceof Error ? cause.message : `${item.herb}剂量无法识别`); continue }
    let line: PrescriptionLine
    try { line = matchPrescriptionToInventory([raw], herbs, units)[0] }
    catch (cause) { notes.push(cause instanceof Error ? cause.message : `${raw.herb}剂量无法识别`); continue }
    const name = normalizeHerbName(line.herb), previous = combined.get(name)
    if (previous && previous.unit !== line.unit) { notes.push(`${line.herb}在方子里用了不同单位`); continue }
    combined.set(name, { ...line, quantity: line.quantity + (previous?.quantity ?? 0) })
  }
  for (const line of combined.values()) {
    const herb = herbs.find(item => item.normalizedName === normalizeHerbName(line.herb))
    if (!herb) notes.push(`库里没有${line.herb}`)
    else if (!herb.enabled) notes.push(`${herb.name}已停用`)
    else {
      const amount = toSmallestUnit(line.quantity, herb.unit, units)
      if (amount > herb.quantity) notes.push(`${herb.name}库存不足，差 ${fromSmallestUnit(amount - herb.quantity, herb.unit, units)}${herb.unit}`)
    }
  }
  return notes
}
export function parsePrescriptionDose(herb: string, dose: string): PrescriptionLine {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(克|g|钱|两|片|枚|个)\s*$/iu.exec(dose)
  if (!match) throw Error(`“${herb} ${dose}”的剂量格式无法识别`)
  const unit: HerbUnit = match[2] === 'g' ? '克' : match[2] as HerbUnit
  const quantity = Number(match[1]); validateHerbAmount(quantity, unit)
  return { herb, quantity, unit }
}
export function matchPrescriptionToInventory(lines: PrescriptionLine[], herbs: Herb[], units: HerbUnits): PrescriptionLine[] {
  const config = validateHerbUnits(units)
  return lines.map(line => {
    const herb = herbs.find(item => item.normalizedName === normalizeHerbName(line.herb))
    if (!herb || herb.unit === line.unit) return line
    const sourceIsMass = MASS_UNITS.includes(line.unit), targetIsMass = MASS_UNITS.includes(herb.unit)
    if (!sourceIsMass || !targetIsMass) throw Error(`${herb.name}的药材单位与方子不一致`)
    const smallest = toSmallestUnit(line.quantity, line.unit, config)
    const factor = herb.unit === '克' ? 10 : herb.unit === '钱' ? config.qianInTenthsGram : config.liangInTenthsGram
    if (!factor || smallest % factor !== 0) throw Error(`${herb.name}按本机换算不能精确扣库存`)
    return { herb: line.herb, quantity: smallest / factor, unit: herb.unit }
  })
}
function fromSmallestUnit(amount: number, unit: HerbUnit, config: HerbUnits): number {
  if (unit === '克') return amount / 10
  if (unit === '钱') return amount / (config.qianInTenthsGram ?? 1)
  if (unit === '两') return amount / (config.liangInTenthsGram ?? 1)
  return amount
}
/** 远程问诊自动附上可准确表示的库存；钱、两换算未配置时只发克与份数。 */
export function snapshotHomeHerbs(herbs: readonly Herb[], units: HerbUnits): SharedHomeHerbSnapshot[] {
  const config = validateHerbUnits(units)
  const result: SharedHomeHerbSnapshot[] = []
  for (const herb of herbs) {
    if (!herb.enabled) continue
    if ((herb.unit === '钱' && config.qianInTenthsGram === null) || (herb.unit === '两' && config.liangInTenthsGram === null)) continue
    const quantity = fromSmallestUnit(herb.quantity, herb.unit, config)
    validateHerbAmount(quantity, herb.unit, true)
    result.push({ name: herb.name, quantity, unit: herb.unit })
  }
  return result
}
export function cleanSharedHomeHerbs(value: unknown): SharedHomeHerb[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) throw Error('附带的家中药材格式无效')
  const rows = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('附带的家中药材格式无效')
    const row = item as Record<string, unknown>
    const name = normalizeHerbName(row.name)
    if (name.length > 40) throw Error('附带的家中药材格式无效')
    if (row.unit !== undefined) {
      validateHerbUnit(row.unit)
      validateHerbAmount(row.quantity, row.unit, true)
      return { name, quantity: row.quantity as number, unit: row.unit }
    }
    if (row.status === '够' || row.status === '快没了') return { name, status: row.status }
    throw Error('附带的家中药材格式无效')
  })
  return rows.length ? rows as SharedHomeHerb[] : undefined
}
export function labelPrescriptionHerbs(lines: PrescriptionLine[], shared: SharedHomeHerb[] = []): { herb: string; label: '学生家里有' | '要另抓' }[] {
  const available = new Set(shared.map(item => normalizeHerbName(item.name)))
  return lines.map(line => ({ herb: line.herb, label: available.has(normalizeHerbName(line.herb)) ? '学生家里有' : '要另抓' }))
}

export interface PrescriptionStockLabel { herb: string; text: string; kind: 'enough' | 'shortage' | 'buy' | 'unknown' }

function quantityLabel(smallest: number, unit: HerbUnit): string {
  if (MASS_UNITS.includes(unit)) return `${(smallest / 10).toFixed(1).replace(/\.0$/, '')} 克`
  return `${smallest}${unit}`
}

/** 只做库存对照，不改处方；不确定的单位或剂量明确留给老师/学生核对。 */
export function assessPrescriptionStock(
  lines: readonly { herb: string; dose: string }[], shared: readonly SharedHomeHerb[], units: HerbUnits,
): PrescriptionStockLabel[] {
  const config = validateHerbUnits(units)
  return lines.map(item => {
    let dose: PrescriptionLine
    try { dose = parsePrescriptionDose(item.herb, item.dose) }
    catch { return { herb: item.herb, text: `剂量无法识别，跳过库存判断：${item.dose}`, kind: 'unknown' } }
    if ((dose.unit === '钱' && config.qianInTenthsGram === null) || (dose.unit === '两' && config.liangInTenthsGram === null)) {
      return { herb: item.herb, text: '钱、两的换算尚未确认，暂不核对库存', kind: 'unknown' }
    }
    const match = shared.find(row => normalizeHerbName(row.name) === normalizeHerbName(item.herb))
    if (!match) return { herb: item.herb, text: `要另抓 ${item.dose}`, kind: 'buy' }
    if ('status' in match) return { herb: item.herb, text: match.status === '够' ? '学生家里有' : '要另抓', kind: match.status === '够' ? 'enough' : 'buy' }
    if ((match.unit === '钱' && config.qianInTenthsGram === null) || (match.unit === '两' && config.liangInTenthsGram === null)) {
      return { herb: item.herb, text: '钱、两的换算尚未确认，暂不核对库存', kind: 'unknown' }
    }
    const sameMass = MASS_UNITS.includes(match.unit) && MASS_UNITS.includes(dose.unit)
    const sameCount = !MASS_UNITS.includes(match.unit) && match.unit === dose.unit
    if (!sameMass && !sameCount) return { herb: item.herb, text: `单位无法换算，需核对（家里 ${match.quantity}${match.unit}，处方 ${item.dose}）`, kind: 'unknown' }
    const available = match.quantity === 0 ? 0 : toSmallestUnit(match.quantity, match.unit, config)
    const needed = toSmallestUnit(dose.quantity, dose.unit, config)
    if (available >= needed) {
      const doseCount = Math.floor(available / needed)
      return { herb: item.herb, text: `家里有 ${quantityLabel(available, match.unit)}，够 ${doseCount} 剂`, kind: 'enough' }
    }
    return { herb: item.herb, text: `家里不够，差 ${quantityLabel(needed - available, dose.unit)}`, kind: 'shortage' }
  })
}

/** 当前方子下次服用所需的库存提醒；绝不建议改量或改方。 */
export function studentHerbReminders(herbs: readonly Herb[], units: HerbUnits, prescription: readonly { herb: string; dose: string }[] = []): string[] {
  const config = validateHerbUnits(units)
  const reminders: string[] = []
  for (const herb of herbs) {
    if (!herb.enabled || herb.quantity > herb.threshold) continue
    if ((herb.unit === '钱' && config.qianInTenthsGram === null) || (herb.unit === '两' && config.liangInTenthsGram === null)) continue
    reminders.push(`${herb.name}库存偏低，剩余 ${quantityLabel(herb.quantity, herb.unit)}`)
  }
  for (const line of assessPrescriptionStock(prescription, snapshotHomeHerbs(herbs, config), config)) {
    if (line.kind === 'shortage') reminders.push(`${line.herb}${line.text.replace('家里不够，', '不够下一剂，')}`)
    else if (line.kind === 'buy') reminders.push(`${line.herb}需要补货：${line.text.replace('要另抓 ', '')}`)
    else if (line.kind === 'unknown') reminders.push(`${line.herb}${line.text}`)
  }
  return [...new Set(reminders)]
}
export async function reversePrescription(store: Pick<HerbStore, 'atomic'>, ref: string, key: string, at = new Date()): Promise<HerbLedger[]> {
  if (!ref.trim() || !key.trim()) throw Error('作废病历编号无效')
  return store.atomic(async tx => {
    const rows = (await tx.list(HERB_LEDGER)).map(row => asLedger(row.value))
    if (rows.some(row => row.ref === ref && row.reason === '作废冲回')) return []
    const original = rows.filter(row => row.ref === ref && row.reason === '开方扣减')
    if (!original.length) return []
    if (rows.some(row => row.key === key)) return []
    const reversals: HerbLedger[] = []
    for (const row of original) {
      if (row.delta >= 0) continue
      const value = await tx.get(HERBS, row.herb)
      if (!value) throw Error('作废冲回失败：找不到原药材')
      const herb = asHerb(value); herb.quantity += -row.delta
      const entry: HerbLedger = { id: randomId(), herb: row.herb, delta: -row.delta, reason: '作废冲回', ref, at: at.toISOString(), balanceAfter: herb.quantity, key }
      tx.put(HERBS, herb.id, herb as unknown as StoreValue); tx.put(HERB_LEDGER, entry.id, entry as unknown as StoreValue); reversals.push(entry)
    }
    return reversals
  })
}
