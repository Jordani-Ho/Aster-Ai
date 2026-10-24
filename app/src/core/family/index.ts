import { createIdentity, identityFromPrivateKey, type Identity } from '../identity'
import type { LocalStore, StoreValue } from '../store'
import { loadTeachers, saveTeachers } from '../inbox'
import { emptyProfile, loadProfile, saveProfile } from '../intake/session'
import type { Encounter } from '../record/types'
import { ageAt, cities, toBazi } from '../../../../domain/tcm/bazi'
import { BASICS_COLLECTION, BASICS_KEY, checkBirthDate, checkRelationAge, loadBasics } from '../basics'

// M1-22 家人子账户：本人是根身份（account 0），每位家人在本机随机生成独立身份，
// account 序号只用于展示与排序。每位家人的本机资料存进同一个库的独立分片
// （集合名加 `f编号-` 前缀），所以逻辑上互不可见。
export const FAMILY_COLLECTION = 'family'
export const FAMILY_KEY = 'members'
export const MAX_FAMILY_MEMBERS = 8

// V2-23：关系多了配偶、兄弟姐妹、祖父母、孙辈；和年龄要讲得通（见 core/basics checkRelationAge）。
export type FamilyRelation = 'father' | 'mother' | 'child' | 'spouse' | 'sibling' | 'grandparent' | 'grandchild' | 'other'
export const FAMILY_RELATIONS: readonly FamilyRelation[] = ['father', 'mother', 'child', 'spouse', 'sibling', 'grandparent', 'grandchild', 'other']
export const RELATION_LABELS: Record<FamilyRelation, string> = { father: '爸爸', mother: '妈妈', child: '孩子', spouse: '配偶', sibling: '兄弟姐妹', grandparent: '祖父母', grandchild: '孙辈', other: '其他' }
export type FamilyGender = 'male' | 'female'

export interface FamilyMember {
  account: number
  alias: string
  relation: FamilyRelation
  gender: FamilyGender
  birthDate: string
  city: string | null
  publicKey: string
  /** 随机生成的家人私钥；仅供本机代管使用。 */
  privateKey: string
}

export interface FamilyDraft {
  account?: number
  alias: string
  relation: FamilyRelation
  gender: FamilyGender
  birthDate: string
  city?: string | null
}

const HEX64 = /^[0-9a-f]{64}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function familyPrefix(account: number): string {
  if (!Number.isSafeInteger(account) || account < 1 || account >= 2 ** 31) throw new Error('家人编号必须是 1 至 2147483647 的整数')
  return `f${account}-`
}

export function memberStore(rootStore: LocalStore, account: number): LocalStore {
  return rootStore.scoped(familyPrefix(account))
}

export function memberIdentity(member: FamilyMember): Identity {
  const identity = identityFromPrivateKey(hexBytes(member.privateKey))
  if (identity.publicKey !== member.publicKey) {
    identity.privateKey.fill(0)
    throw new Error('家人资料与本机记录不一致')
  }
  return identity
}

export function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('家人资料与本机记录不一致')
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16))
}

function hexString(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  try { checkBirthDate(value); return true } catch { return false }
}

export function normalizeDraft(draft: FamilyDraft): Required<Omit<FamilyDraft, 'account'>> & { account?: number } {
  const alias = typeof draft?.alias === 'string' ? draft.alias.trim() : ''
  if (alias === '' || alias.length > 12) throw new Error('家人的称呼需要 1 至 12 个字')
  if (/[\u0000-\u001f\u007f]/.test(alias)) throw new Error('家人的称呼不能包含换行等控制字符')
  if (!FAMILY_RELATIONS.includes(draft.relation)) throw new Error('请选择家人关系')
  if (draft.gender !== 'male' && draft.gender !== 'female') throw new Error('请选择性别')
  checkBirthDate(draft.birthDate)
  const city = typeof draft.city === 'string' && draft.city.trim() !== '' ? draft.city.trim() : null
  if (city !== null && !cities.some(item => item.nameZh === city || item.nameEn === city)) throw new Error('请从列表中选择居住城市')
  if (draft.account !== undefined && (!Number.isSafeInteger(draft.account) || draft.account < 1 || draft.account >= 2 ** 31)) throw new Error('家人编号无效')
  return { alias, relation: draft.relation, gender: draft.gender, birthDate: draft.birthDate, city, ...(draft.account === undefined ? {} : { account: draft.account }) }
}

function parseMember(value: unknown): FamilyMember | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const member = value as Record<string, unknown>
  if (!Number.isSafeInteger(member.account) || (member.account as number) < 1 || (member.account as number) >= 2 ** 31) return null
  if (typeof member.alias !== 'string' || member.alias === '' || member.alias.length > 12) return null
  if (!FAMILY_RELATIONS.includes(member.relation as FamilyRelation)) return null
  if (member.gender !== 'male' && member.gender !== 'female') return null
  if (!validDate(member.birthDate)) return null
  if (member.city !== null && typeof member.city !== 'string') return null
  if (typeof member.publicKey !== 'string' || !HEX64.test(member.publicKey)) return null
  if (typeof member.privateKey !== 'string' || !HEX64.test(member.privateKey)) return null
  return {
    account: member.account as number,
    alias: member.alias,
    relation: member.relation as FamilyRelation,
    gender: member.gender,
    birthDate: member.birthDate,
    city: member.city as string | null,
    publicKey: member.publicKey,
    privateKey: member.privateKey,
  }
}

export async function loadFamilyMembers(rootStore: LocalStore): Promise<FamilyMember[]> {
  const value = await rootStore.get(FAMILY_COLLECTION, FAMILY_KEY)
  if (!Array.isArray(value)) return []
  const members: FamilyMember[] = []
  for (const item of value) {
    const member = parseMember(item)
    if (member && !members.some(existing => existing.account === member.account)) members.push(member)
  }
  return members.sort((left, right) => left.account - right.account)
}

function field<T>(value: T | null): { value: T | null; source: 'student' | 'unknown' } {
  return value === null ? { value: null, source: 'unknown' } : { value, source: 'student' }
}

async function memberProfile(rootStore: LocalStore, draft: ReturnType<typeof normalizeDraft>): Promise<Encounter['profile']> {
  const owner = await loadProfile(rootStore)
  const city = draft.city === null ? null : cities.find(item => item.nameZh === draft.city || item.nameEn === draft.city) ?? null
  let bazi: Encounter['profile']['bazi']['value'] = null
  if (city) {
    try {
      const result = await toBazi({ date: draft.birthDate, city })
      bazi = { year: result.year, month: result.month, day: result.day, hour: result.hour, flags: [...result.flags] }
    } catch { bazi = null }
  }
  const today = new Date()
  const localToday = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-')
  const profile = emptyProfile()
  profile.alias = field(draft.alias)
  profile.gender = field(draft.gender)
  profile.age = field(ageAt(draft.birthDate, localToday))
  profile.bazi = field(bazi)
  profile.city = field(draft.city)
  profile.managedBy = field(owner.alias.value ?? '本人')
  return profile
}

// 添加家人：随机生成身份 → 写本机家人清单 → 初始化这位家人的本机档案与“我的老师”（与本人同一批）。
export async function addFamilyMember(rootStore: LocalStore, rootIdentity: Identity, draft: FamilyDraft): Promise<FamilyMember> {
  const value = normalizeDraft(draft)
  // V2-23：本人填过出生日期时，家人关系与年龄必须讲得通。
  const owner = await loadBasics(rootStore)
  if (owner.birthDate) checkRelationAge(value.relation, value.birthDate, owner.birthDate, RELATION_LABELS)
  const members = await loadFamilyMembers(rootStore)
  if (members.length >= MAX_FAMILY_MEMBERS) throw new Error('最多添加 8 位家人')
  if (value.account !== undefined && members.some(member => member.account === value.account)) throw new Error('这个家人编号已经用过')
  const account = value.account ?? Math.max(0, ...members.map(member => member.account)) + 1
  const generated = createIdentity()
  const member: FamilyMember = {
    account,
    alias: value.alias,
    relation: value.relation,
    gender: value.gender,
    birthDate: value.birthDate,
    city: value.city,
    publicKey: generated.publicKey,
    privateKey: hexString(generated.privateKey),
  }
  generated.privateKey.fill(0)
  if (member.publicKey === rootIdentity.publicKey || members.some(existing => existing.publicKey === member.publicKey)) throw new Error('家人身份生成重复，请重试')
  const scoped = memberStore(rootStore, account)
  await saveTeachers(scoped, await loadTeachers(rootStore))
  await saveProfile(scoped, await memberProfile(rootStore, value))
  // V2-23：家人的基础信息用同一张表，先把添加时已知的几项填进去。
  await scoped.put(BASICS_COLLECTION, BASICS_KEY, { alias: value.alias, gender: value.gender, birthDate: value.birthDate, birthShichen: null } as unknown as StoreValue)
  await rootStore.put(FAMILY_COLLECTION, FAMILY_KEY, [...members, member] as unknown as StoreValue)
  return member
}

// V2-06：管理人在家人设置里给某位家人单独设城市（城市影响这位家人的真太阳时/时辰）。
// 时间显示方式与照镜子时辰仍沿用管理人自己的设置，不在这里单独设。
export async function setFamilyMemberCity(rootStore: LocalStore, account: number, city: string | null): Promise<FamilyMember[]> {
  const members = await loadFamilyMembers(rootStore)
  const target = members.find(member => member.account === account)
  if (!target) throw new Error('没有这位家人')
  const value = typeof city === 'string' && city.trim() !== '' ? city.trim() : null
  if (value !== null && !cities.some(item => item.nameZh === value || item.nameEn === value)) throw new Error('请从列表中选择居住城市')
  const scoped = memberStore(rootStore, account)
  const profile = await loadProfile(scoped)
  await saveProfile(scoped, { ...profile, city: field(value) })
  const next = members.map(member => member.account === account ? { ...member, city: value } : member)
  await rootStore.put(FAMILY_COLLECTION, FAMILY_KEY, next as unknown as StoreValue)
  return next
}

export async function removeFamilyMember(rootStore: LocalStore, account: number): Promise<FamilyMember[]> {
  const members = await loadFamilyMembers(rootStore)
  const remaining = members.filter(member => member.account !== account)
  await rootStore.put(FAMILY_COLLECTION, FAMILY_KEY, remaining as unknown as StoreValue)
  await rootStore.clearScope(familyPrefix(account)).catch(() => {})
  return remaining
}

// 老师端展示用：家人问诊显示“称呼（代管人代管）”，本人问诊只显示称呼。
export function managedLabel(profile: Encounter['profile']): string {
  const alias = profile.alias.value ?? '未填称呼'
  const manager = profile.managedBy?.value ?? null
  return manager && manager !== alias ? `${alias}（${manager}代管）` : alias
}

// 测试与界面共用：把出生日期换成今天的年龄，越界返回 null。
export function familyAge(birthDate: string, now: Date = new Date()): number | null {
  const localToday = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
  try { return ageAt(birthDate, localToday) } catch { return null }
}
