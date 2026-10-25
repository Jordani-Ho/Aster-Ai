import type { LocalStore, StoreValue } from '../store'
import type { Encounter } from '../record/types'
import { emptyProfile, loadProfile, saveProfile } from '../intake/session'
import { ageAt, cities, toBazi } from '../../../../domain/tcm/bazi'

// V2-23 进馆基础信息：学生智能体进入角色。资料只留在本机（家人在各自分片里）；
// 老师端照旧只从 profile 收到称呼、性别、年龄、八字、城市五项。西医诊断不进问诊包。
export const BASICS_COLLECTION = 'basics'
export const BASICS_KEY = 'self'
export const BASICS_HISTORY = 'basics-history'
export const ROUTINE_SETTING = 'agent-routine'

export const SHICHEN_NAMES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'] as const
export type Shichen = typeof SHICHEN_NAMES[number]
export type BasicsGender = 'male' | 'female' | 'other'

export interface StudentBasics {
  alias: string
  gender: BasicsGender
  birthDate: string
  /** null = 不知道 */
  birthShichen: Shichen | null
  birthPlace: string | null
  /** 居住城市与 profile.city 是同一份；读时以 profile 为准。 */
  city: string
  diagnoses: string[]
  history: string | null
  meds: string | null
  allergies: string | null
  routine: { wake: string | null; sleep: string | null }
}

export type BasicsDraft = Partial<Omit<StudentBasics, 'routine'>> & { routine?: Partial<StudentBasics['routine']> }

export const REQUIRED_LABELS = { alias: '称呼', gender: '性别', birthDate: '出生日期', city: '居住城市' } as const
export type RequiredKey = keyof typeof REQUIRED_LABELS

export class BirthChangeNeedsConfirm extends Error {
  constructor() { super('改出生日期或时辰会影响八字推算，请确认后再保存') }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
const CONTROL = /[\u0000-\u001f\u007f]/
// 时辰取中点推八字；子时取 00:30（早子时），避开跨日。
const SHICHEN_CLOCK: Record<Shichen, string> = { 子: '00:30', 丑: '02:00', 寅: '04:00', 卯: '06:00', 辰: '08:00', 巳: '10:00', 午: '12:00', 未: '14:00', 申: '16:00', 酉: '18:00', 戌: '20:00', 亥: '22:00' }

export function localDay(now: Date = new Date()): string {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
}

function realDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const [, y, m, d] = DATE.exec(value)!
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)
}

/** 出生日期：合法日期、不晚于今天、年龄 0–120 岁。 */
export function checkBirthDate(value: unknown, now: Date = new Date()): string {
  if (!realDate(value)) throw new Error('请填写有效的出生日期')
  const today = localDay(now)
  if (value > today) throw new Error('出生日期不能晚于今天')
  if (ageAt(value, today) > 120) throw new Error('出生日期算出来超过 120 岁，请检查年份')
  return value
}

function text(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${label}格式不对`)
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > max) throw new Error(`${label}最多 ${max} 字`)
  return trimmed
}

function cityName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new Error('请从列表中选择居住城市')
  const found = cities.find(item => item.nameZh === value.trim() || item.nameEn === value.trim())
  if (!found) throw new Error('请从列表中选择居住城市')
  return found.nameZh
}

function clock(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !CLOCK.test(value)) throw new Error(`${label}请填写钟点，例如 07:00`)
  return value
}

/**
 * 校验并整理一份草稿。必填项缺了不报错（由 missingRequired 说还差什么），
 * 但填了的每一项都必须合法。
 */
export function normalizeBasics(draft: BasicsDraft, now: Date = new Date()): Partial<StudentBasics> {
  const out: Partial<StudentBasics> = {}
  const alias = text(draft.alias, 30, '称呼')
  if (alias !== null) {
    if (CONTROL.test(alias)) throw new Error('称呼不能包含换行等控制字符')
    out.alias = alias
  }
  if (draft.gender !== undefined && draft.gender !== null) {
    if (draft.gender !== 'male' && draft.gender !== 'female' && draft.gender !== 'other') throw new Error('请选择性别')
    out.gender = draft.gender
  }
  if (draft.birthDate !== undefined && draft.birthDate !== null && draft.birthDate !== '') out.birthDate = checkBirthDate(draft.birthDate, now)
  if (draft.birthShichen !== undefined) {
    if (draft.birthShichen !== null && !SHICHEN_NAMES.includes(draft.birthShichen as Shichen)) throw new Error('出生时辰只能选十二时辰之一，或“不知道”')
    out.birthShichen = draft.birthShichen ?? null
  }
  if (draft.birthPlace !== undefined) out.birthPlace = cityName(draft.birthPlace)
  const city = cityName(draft.city)
  if (city !== null) out.city = city
  if (draft.diagnoses !== undefined) {
    if (!Array.isArray(draft.diagnoses)) throw new Error('西医诊断格式不对')
    const list = draft.diagnoses.map(item => text(item, 40, '每条西医诊断')).filter((item): item is string => item !== null)
    if (list.length > 10) throw new Error('西医诊断最多 10 条')
    out.diagnoses = [...new Set(list)]
  }
  if (draft.history !== undefined) out.history = text(draft.history, 500, '既往病史')
  if (draft.meds !== undefined) out.meds = text(draft.meds, 300, '在用药')
  if (draft.allergies !== undefined) out.allergies = text(draft.allergies, 300, '过敏')
  if (draft.routine !== undefined) {
    out.routine = { wake: clock(draft.routine.wake, '起床时间'), sleep: clock(draft.routine.sleep, '睡觉时间') }
  }
  return out
}

export function missingRequired(basics: Partial<StudentBasics> | null): RequiredKey[] {
  const value = basics ?? {}
  return (Object.keys(REQUIRED_LABELS) as RequiredKey[]).filter(key => !value[key])
}

export function missingLabels(basics: Partial<StudentBasics> | null): string[] {
  return missingRequired(basics).map(key => REQUIRED_LABELS[key])
}

/** 读本机基础信息；居住城市以 profile.city 为准（“我的时间”里改城市也算数）。 */
export async function loadBasics(store: LocalStore): Promise<Partial<StudentBasics>> {
  const saved = await store.get(BASICS_COLLECTION, BASICS_KEY)
  let value: Partial<StudentBasics> = {}
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    try { value = normalizeBasics(saved as BasicsDraft) } catch { value = {} }
  }
  const profile = await loadProfile(store)
  // 以前在别处填过的称呼沿用，不再让人重填。
  if (!value.alias && typeof profile.alias.value === 'string' && profile.alias.value.trim() !== '') value.alias = profile.alias.value.trim().slice(0, 30)
  const city = profile.city.value
  if (city) { try { const name = cityName(city); if (name) value.city = name } catch { /* 旧数据里的城市不在列表里就当没填 */ } }
  else delete value.city
  return value
}

async function shichenBazi(birthDate: string, shichen: Shichen | null, city: string | null): Promise<Encounter['profile']['bazi']['value']> {
  const place = city ? cities.find(item => item.nameZh === city) ?? null : null
  if (!place) return null
  try {
    const result = await toBazi({ date: birthDate, city: place, time: shichen ? SHICHEN_CLOCK[shichen] : null })
    return { year: result.year, month: result.month, day: result.day, hour: result.hour, flags: [...result.flags] }
  } catch { return null }
}

/**
 * 把基础信息投影到问诊用的 profile（只五项）。年龄和八字每次现算，不存成死值；
 * 没有出生日期就不推算。家人的 managedBy 原样保留。
 */
export async function refreshProfile(store: LocalStore, now: Date = new Date()): Promise<Encounter['profile']> {
  const basics = await loadBasics(store)
  const current = await loadProfile(store)
  const profile = emptyProfile()
  if (current.managedBy) profile.managedBy = current.managedBy
  const field = <T,>(value: T | null | undefined) => value === null || value === undefined ? { value: null, source: 'unknown' as const } : { value, source: 'student' as const }
  profile.alias = basics.alias ? field(basics.alias) : current.alias
  profile.gender = basics.gender ? field(basics.gender) : current.gender
  profile.city = basics.city ? field(basics.city) : current.city
  if (basics.birthDate) {
    profile.age = field(ageAt(basics.birthDate, localDay(now)))
    profile.bazi = field(await shichenBazi(basics.birthDate, basics.birthShichen ?? null, basics.city ?? null))
  } else {
    // 没有出生日期就不推算：旧 profile 里存过的年龄、八字也不再带给老师（Codex 审核 #67）。
    profile.age = { value: null, source: 'unknown' }
    profile.bazi = { value: null, source: 'unknown' }
  }
  await saveProfile(store, profile)
  return profile
}

/**
 * 保存基础信息。改出生日期或时辰时必须 confirmBirth，并在本机留一条修改记录。
 * 返回保存后的完整值和还缺的必填项。
 */
export async function saveBasics(store: LocalStore, draft: BasicsDraft, options: { confirmBirth?: boolean; now?: Date } = {}): Promise<{ basics: Partial<StudentBasics>; missing: string[] }> {
  const now = options.now ?? new Date()
  const next = normalizeBasics(draft, now)
  const before = await loadBasics(store)
  const changes: { field: 'birthDate' | 'birthShichen'; from: string | null; to: string | null }[] = []
  if (before.birthDate && next.birthDate && before.birthDate !== next.birthDate) changes.push({ field: 'birthDate', from: before.birthDate, to: next.birthDate })
  if (before.birthDate && next.birthShichen !== undefined && (before.birthShichen ?? null) !== next.birthShichen) changes.push({ field: 'birthShichen', from: before.birthShichen ?? null, to: next.birthShichen })
  if (changes.length > 0 && !options.confirmBirth) throw new BirthChangeNeedsConfirm()
  const merged: Partial<StudentBasics> = { ...before, ...next }
  const { city: _city, ...stored } = merged
  await store.put(BASICS_COLLECTION, BASICS_KEY, stored as unknown as StoreValue)
  // 城市只在这次填了时才改；没填就保留“我的时间”里原来的城市。
  if (next.city !== undefined) {
    const profile = await loadProfile(store)
    await saveProfile(store, { ...profile, city: { value: next.city, source: 'student' } })
  }
  for (const change of changes) {
    await store.put(BASICS_HISTORY, crypto.randomUUID(), { at: now.toISOString(), ...change } as unknown as StoreValue)
  }
  if (merged.routine) await store.put('settings', ROUTINE_SETTING, merged.routine as unknown as StoreValue)
  await refreshProfile(store, now)
  const saved = await loadBasics(store)
  return { basics: saved, missing: missingLabels(saved) }
}

export async function listBirthChanges(store: LocalStore): Promise<{ at: string; field: string; from: string | null; to: string | null }[]> {
  const rows = await store.list(BASICS_HISTORY)
  return rows.map(row => row.value as unknown as { at: string; field: string; from: string | null; to: string | null })
    .sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * 老用户判定：已经发过问诊或收到过病历的人不拦，只在首页提示补齐。
 */
export async function isExistingStudent(store: LocalStore): Promise<boolean> {
  const [sent, records] = await Promise.all([store.list('intake-sent'), store.list('student-records')])
  return sent.length > 0 || records.length > 0
}

/** 第一次问诊前的门槛：必填项不全且不是老用户时拦住。 */
export async function consultGate(store: LocalStore): Promise<{ allowed: boolean; missing: string[]; existing: boolean }> {
  const basics = await loadBasics(store)
  const missing = missingLabels(basics)
  const existing = missing.length > 0 ? await isExistingStudent(store) : false
  return { allowed: missing.length === 0 || existing, missing, existing }
}

/** 问诊卡里自动带上的既往史与用药过敏（学生可改）。 */
export async function intakeDefaults(store: LocalStore): Promise<{ history: string | null; medsAllergies: string | null }> {
  const basics = await loadBasics(store)
  const meds = [basics.meds ? `在用药：${basics.meds}` : null, basics.allergies ? `过敏：${basics.allergies}` : null].filter(Boolean).join('；')
  return { history: basics.history ?? null, medsAllergies: meds === '' ? null : meds }
}

// 家人关系与年龄要讲得通：父母至少大 12 岁、祖父母至少大 30 岁；子女、孙辈反过来。
export type AgeRelation = 'father' | 'mother' | 'child' | 'spouse' | 'sibling' | 'grandparent' | 'grandchild' | 'other'
const OLDER_BY: Partial<Record<AgeRelation, number>> = { father: 12, mother: 12, grandparent: 30 }
const YOUNGER_BY: Partial<Record<AgeRelation, number>> = { child: 12, grandchild: 30 }

function yearsBetween(earlier: string, later: string): number {
  if (later < earlier) return -yearsBetween(later, earlier)
  return ageAt(earlier, later)
}

/** member 相对本人（owner）的关系。讲不通就抛错并说明。 */
export function checkRelationAge(relation: AgeRelation, memberBirth: string, ownerBirth: string, labels: Record<string, string> = {}): void {
  const name = labels[relation] ?? relation
  const older = OLDER_BY[relation]
  if (older !== undefined) {
    if (memberBirth >= ownerBirth || yearsBetween(memberBirth, ownerBirth) < older) throw new Error(`${name}的出生日期应比您早至少 ${older} 年，请检查`)
  }
  const younger = YOUNGER_BY[relation]
  if (younger !== undefined) {
    if (memberBirth <= ownerBirth || yearsBetween(ownerBirth, memberBirth) < younger) throw new Error(`${name}的出生日期应比您晚至少 ${younger} 年，请检查`)
  }
}
