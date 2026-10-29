import type { LocalStore, StoreValue } from '../store'
import type { Envelope } from '../transport'
import { validCityName } from '../city'
import { refreshProfile, loadBasics, missingLabels } from '../basics'

const hex = /^[0-9a-f]{64}$/
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
function validText(x: unknown, max: number): x is string { return typeof x === 'string' && x.trim() === x && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x) }
function validBazi(x: unknown): boolean {
  if (x === null) return true
  if (!isObject(x) || Object.keys(x).sort().join(',') !== 'day,flags,hour,month,year' || !validText(x.day, 20)) return false
  if (![x.year,x.month,x.hour].every(v => v === null || validText(v, 20))) return false
  return Array.isArray(x.flags) && x.flags.length <= 20 && x.flags.every(v => validText(v, 40))
}
export function validReady(x: unknown): x is Record<string, unknown> {
  return isObject(x) && Object.keys(x).sort().join(',') === 'age,alias,bazi,city,gender'
    && validText(x.alias,30) && ['male','female','other'].includes(String(x.gender))
    && Number.isSafeInteger(x.age) && (x.age as number) >= 0 && (x.age as number) <= 150
    && validBazi(x.bazi) && validCityName(x.city)
}
export async function receiveStudentBasicsReady(store: LocalStore, student: string, payload: unknown, at: number): Promise<boolean> {
  if (!hex.test(student) || !Number.isSafeInteger(at) || at <= 0 || !validReady(payload)) return false
  return store.atomic(async tx => {
    const member = await tx.get('teacher-students', student) as { student?: unknown } | undefined
    if (await tx.get('teacher-roster-leaves', student)) return false
    const collection = member?.student === student ? 'teacher-student-basics' : 'teacher-basics-waiting'
    const prior = await tx.get(collection, student) as { at?: unknown } | undefined
    if (typeof prior?.at === 'number' && prior.at >= at) return false
    tx.put(collection, student, { ...payload, at } as StoreValue)
    if (collection === 'teacher-student-basics' && (typeof (member as { cityUpdatedAt?: unknown }).cityUpdatedAt !== 'number' || ((member as { cityUpdatedAt: number }).cityUpdatedAt < at)))
      tx.put('teacher-students', student, { ...member, city: payload.city, cityUpdatedAt: at } as StoreValue)
    return true
  })
}
export async function queueStudentBasicsReady(store: LocalStore): Promise<void> {
  if (missingLabels(await loadBasics(store)).length) return
  const p = await refreshProfile(store)
  const payload = { alias:p.alias.value, gender:p.gender.value, age:p.age.value, bazi:p.bazi.value, city:p.city.value }
  if (!validReady(payload)) throw Error('基础信息投影无效')
  const teachers = await store.get('settings', 'teachers')
  if (Array.isArray(teachers)) for (const teacher of teachers) if (typeof teacher === 'string' && hex.test(teacher)) await store.put('student-basics-pending', teacher, payload as StoreValue)
}
export async function sendPendingStudentBasics(store: LocalStore, send: (teacher:string, envelope:Envelope)=>Promise<unknown>): Promise<void> {
  for (const row of await store.list('student-basics-pending')) {
    if (!hex.test(row.key) || !validReady(row.value)) continue
    const teachers = await store.get('settings', 'teachers')
    if (!Array.isArray(teachers) || !teachers.includes(row.key)) { await store.delete('student-basics-pending', row.key); continue }
    await send(row.key, { type:'student.basics-ready', version:1, payload:row.value })
    await store.atomic(async tx => {
      const current = await tx.get('student-basics-pending', row.key)
      if (JSON.stringify(current) === JSON.stringify(row.value)) tx.delete('student-basics-pending', row.key)
    })
  }
}

/** 已验证邀请后才启用可能先到的资料。 */
export async function attachWaitingBasics(store: LocalStore, student: string): Promise<void> {
  await store.atomic(async tx => {
    const pending = await tx.get('teacher-basics-waiting', student) as Record<string, unknown> | undefined
    if (!pending) return
    const { at, ...payload } = pending
    const prior = await tx.get('teacher-student-basics', student) as { at?: unknown } | undefined
    if (Number.isSafeInteger(at) && validReady(payload) && (typeof prior?.at !== 'number' || (at as number) > prior.at)) {
      tx.put('teacher-student-basics', student, pending as StoreValue)
      const member = await tx.get('teacher-students', student) as { cityUpdatedAt?: unknown } | undefined
      if (member && (typeof member.cityUpdatedAt !== 'number' || member.cityUpdatedAt < (at as number))) tx.put('teacher-students', student, { ...member, city: payload.city, cityUpdatedAt: at } as StoreValue)
    }
    tx.delete('teacher-basics-waiting', student)
  })
}
