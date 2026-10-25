import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type LocalStore } from '../store'
import { emptyProfile, loadProfile, saveProfile } from '../intake/session'
import { addFamilyMember, loadFamilyMembers, memberStore } from '../family'
import {
  BirthChangeNeedsConfirm, checkBirthDate, checkRelationAge, consultGate, intakeDefaults, listBirthChanges,
  loadBasics, missingLabels, normalizeBasics, refreshProfile, saveBasics,
} from './index'

const handles: LocalStore[] = []
const factory = new IDBFactory()
async function open(): Promise<LocalStore> {
  const store = await openStore(createIdentity(), { name: crypto.randomUUID(), factory })
  handles.push(store)
  return store
}
afterEach(async () => { await Promise.all(handles.splice(0).map(store => store.close?.())) })

const NOW = new Date(2026, 9, 24, 12, 0, 0)
const FULL = { alias: '合成小王', gender: 'male' as const, birthDate: '1990-05-06', city: '北京市' }

describe('V2-23 输入校验', () => {
  it('出生日期：不能晚于今天、年龄 0–120、必须是真日期', () => {
    expect(() => checkBirthDate('2026-10-25', NOW)).toThrow('不能晚于今天')
    expect(checkBirthDate('2026-10-24', NOW)).toBe('2026-10-24')
    expect(() => checkBirthDate('1905-10-23', NOW)).toThrow('120')
    expect(checkBirthDate('1906-10-24', NOW)).toBe('1906-10-24')
    expect(() => checkBirthDate('1990-02-30', NOW)).toThrow('有效的出生日期')
    expect(() => checkBirthDate('1990/05/06', NOW)).toThrow('有效的出生日期')
  })

  it('时辰只能是十二时辰之一或不知道；作息必须是合法钟点；城市必须在列表里', () => {
    expect(normalizeBasics({ birthShichen: '寅' }, NOW).birthShichen).toBe('寅')
    expect(normalizeBasics({ birthShichen: null }, NOW).birthShichen).toBe(null)
    expect(() => normalizeBasics({ birthShichen: '早上' as never }, NOW)).toThrow('十二时辰')
    expect(normalizeBasics({ routine: { wake: '06:30', sleep: '23:00' } }, NOW).routine).toEqual({ wake: '06:30', sleep: '23:00' })
    expect(() => normalizeBasics({ routine: { wake: '25:00' } }, NOW)).toThrow('起床时间')
    expect(() => normalizeBasics({ routine: { sleep: '11点' } }, NOW)).toThrow('睡觉时间')
    expect(() => normalizeBasics({ city: '火星城' }, NOW)).toThrow('列表')
    expect(() => normalizeBasics({ alias: '小\n王' }, NOW)).toThrow('控制字符')
    expect(() => normalizeBasics({ alias: '长'.repeat(31) }, NOW)).toThrow('30')
  })

  it('家人关系与年龄要讲得通', () => {
    const labels = { father: '爸爸', child: '孩子', grandparent: '祖父母', grandchild: '孙辈', spouse: '配偶' }
    expect(() => checkRelationAge('father', '1995-01-01', '1990-05-06', labels)).toThrow('爸爸的出生日期应比您早至少 12 年')
    expect(() => checkRelationAge('father', '1985-01-01', '1990-05-06', labels)).toThrow('12')
    expect(() => checkRelationAge('father', '1960-01-01', '1990-05-06', labels)).not.toThrow()
    expect(() => checkRelationAge('grandparent', '1970-01-01', '1990-05-06', labels)).toThrow('30')
    expect(() => checkRelationAge('child', '1980-01-01', '1990-05-06', labels)).toThrow('孩子的出生日期应比您晚至少 12 年')
    expect(() => checkRelationAge('child', '2016-06-01', '1990-05-06', labels)).not.toThrow()
    expect(() => checkRelationAge('grandchild', '2010-01-01', '1990-05-06', labels)).toThrow('30')
    expect(() => checkRelationAge('spouse', '1999-01-01', '1990-05-06', labels)).not.toThrow()
  })
})

describe('V2-23 保存、门槛与问诊', () => {
  it('新学生：必填项不全时不能问诊，并写明还差哪项；填全后可以', async () => {
    const store = await open()
    let gate = await consultGate(store)
    expect(gate.allowed).toBe(false)
    expect(gate.missing).toEqual(['称呼', '性别', '出生日期', '居住城市'])
    const half = await saveBasics(store, { alias: '合成小王', gender: 'male' }, { now: NOW })
    expect(half.missing).toEqual(['出生日期', '居住城市'])
    gate = await consultGate(store)
    expect(gate.allowed).toBe(false)
    await saveBasics(store, FULL, { now: NOW })
    gate = await consultGate(store)
    expect(gate).toMatchObject({ allowed: true, missing: [] })
  })

  it('老用户（发过问诊或有病历）不拦，但仍报告缺项', async () => {
    const store = await open()
    await store.put('student-records', 'r1', { at: '2026-10-01' })
    const gate = await consultGate(store)
    expect(gate).toMatchObject({ allowed: true, existing: true, missing: ['称呼', '性别', '出生日期', '居住城市'] })
  })

  it('profile 只有原来五项；年龄与八字现算；出生日期、出生地、西医诊断都不进 profile', async () => {
    const store = await open()
    await saveBasics(store, { ...FULL, birthShichen: '午', birthPlace: '上海市', diagnoses: ['合成诊断甲', '合成诊断乙'] }, { now: NOW })
    const profile = await loadProfile(store)
    expect(Object.keys(profile).sort()).toEqual(['age', 'alias', 'bazi', 'city', 'gender'])
    expect(profile.age.value).toBe(36)
    expect(profile.bazi.value?.day).toBeTruthy()
    expect(profile.bazi.value?.hour).toBeTruthy()
    expect(JSON.stringify(profile)).not.toMatch(/1990-05-06|上海|合成诊断/)
    // 过了生日再算一次，年龄跟着变（不是存死的值）。
    const later = await refreshProfile(store, new Date(2027, 5, 1))
    expect(later.age.value).toBe(37)
    expect((await loadBasics(store)).diagnoses).toEqual(['合成诊断甲', '合成诊断乙'])
  })

  it('没有出生日期就不推算八字和年龄', async () => {
    const store = await open()
    await saveBasics(store, { alias: '合成小李', gender: 'female', city: '北京市' }, { now: NOW })
    const profile = await loadProfile(store)
    expect(profile.age.value).toBe(null)
    expect(profile.bazi.value).toBe(null)
    expect(profile.city.value).toBe('北京市')
  })

  it('老用户旧 profile 里存着年龄和八字、但没有出生日期：刷新后都清掉，不带给老师', async () => {
    const store = await open()
    const old = emptyProfile()
    old.alias = { value: '合成老用户', source: 'student' }
    old.age = { value: 40, source: 'student' }
    old.bazi = { value: { year: '甲子', month: '乙丑', day: '丙寅', hour: null, flags: [] }, source: 'student' }
    old.city = { value: '北京市', source: 'student' }
    await saveProfile(store, old)
    const profile = await refreshProfile(store, NOW)
    expect(profile.age.value).toBe(null)
    expect(profile.bazi.value).toBe(null)
    expect(profile.alias.value).toBe('合成老用户')
    expect(profile.city.value).toBe('北京市')
    expect((await loadProfile(store)).age.value).toBe(null)
  })

  it('改出生日期或时辰要先确认，确认后留一条修改记录', async () => {
    const store = await open()
    await saveBasics(store, { ...FULL, birthShichen: '午' }, { now: NOW })
    await expect(saveBasics(store, { birthDate: '1990-05-07' }, { now: NOW })).rejects.toBeInstanceOf(BirthChangeNeedsConfirm)
    expect((await loadBasics(store)).birthDate).toBe('1990-05-06')
    await saveBasics(store, { birthDate: '1990-05-07' }, { now: NOW, confirmBirth: true })
    await expect(saveBasics(store, { birthShichen: null }, { now: NOW })).rejects.toBeInstanceOf(BirthChangeNeedsConfirm)
    await saveBasics(store, { birthShichen: null }, { now: new Date(NOW.getTime() + 1000), confirmBirth: true })
    const changes = await listBirthChanges(store)
    expect(changes.map(change => [change.field, change.from, change.to])).toEqual([['birthDate', '1990-05-06', '1990-05-07'], ['birthShichen', '午', null]])
  })

  it('只改别的项时，不动“我的时间”里的城市；改了城市就同步', async () => {
    const store = await open()
    await saveBasics(store, FULL, { now: NOW })
    await saveBasics(store, { history: '无' }, { now: NOW })
    expect((await loadProfile(store)).city.value).toBe('北京市')
    const profile = await loadProfile(store)
    await saveProfile(store, { ...profile, city: { value: '上海市', source: 'student' } })
    expect((await loadBasics(store)).city).toBe('上海市')
  })

  it('既往史与用药过敏作为问诊卡默认值', async () => {
    const store = await open()
    await saveBasics(store, { ...FULL, history: '合成既往史', meds: '合成药', allergies: '无' }, { now: NOW })
    expect(await intakeDefaults(store)).toEqual({ history: '合成既往史', medsAllergies: '在用药：合成药；过敏：无' })
    const empty = await open()
    expect(await intakeDefaults(empty)).toEqual({ history: null, medsAllergies: null })
  })

  it('作息写进学生智能体的 agent-routine 设置', async () => {
    const store = await open()
    await saveBasics(store, { ...FULL, routine: { wake: '06:30', sleep: '23:00' } }, { now: NOW })
    expect(await store.get('settings', 'agent-routine')).toEqual({ wake: '06:30', sleep: '23:00' })
  })

  it('家人：给“爸爸”填比本人晚的生日被拦；合理的家人自带基础信息', async () => {
    const owner = createIdentity()
    const store = await openStore(owner, { name: crypto.randomUUID(), factory })
    handles.push(store)
    const profile = emptyProfile()
    await saveProfile(store, profile)
    await saveBasics(store, FULL, { now: NOW })
    await expect(addFamilyMember(store, owner, { alias: '爸爸', relation: 'father', gender: 'male', birthDate: '1995-01-01', city: '北京市' })).rejects.toThrow('爸爸的出生日期应比您早至少 12 年')
    expect(await loadFamilyMembers(store)).toEqual([])
    const dad = await addFamilyMember(store, owner, { alias: '爸爸', relation: 'father', gender: 'male', birthDate: '1960-01-01', city: '北京市' })
    const dadBasics = await loadBasics(memberStore(store, dad.account))
    expect(dadBasics).toMatchObject({ alias: '爸爸', gender: 'male', birthDate: '1960-01-01', city: '北京市' })
    expect(missingLabels(dadBasics)).toEqual([])
  })
})
