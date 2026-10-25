import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { defaultSchedule, validateSchedule, effectivePeriods, loadGroundwork, saveGroundwork, groundworkMissing, groundworkStatus, assertInviteReady, GROUNDWORK_ITEMS } from './groundwork'
import { defaultSchema, TEMPLATE_TYPES } from '../../../../domain/tcm/templates/schema'
import { saveTemplateDraft, publishTemplate } from '../templates'
import { loadAgentRole } from '../agent/role'

it('排班默认、边界、例外、时区逐项拒绝坏输入，过去例外不参与计算', () => {
  const schedule = defaultSchedule()
  expect(validateSchedule(schedule)).toEqual(schedule)
  for (const patch of [
    { timezone: 'Not/AZone' }, { duration: 20 }, { capacity: 0 }, { capacity: 21 }, { capacity: 1.5 },
    { week: { ...schedule.week, '1': [{ start: '24:00', end: '25:00' }] } },
    { week: { ...schedule.week, '1': [{ start: '10:00', end: '09:00' }] } },
    { week: { ...schedule.week, '1': [{ start: '09:10', end: '12:00' }] } },
    { week: { ...schedule.week, '1': [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] } },
    { exceptions: [{ date: '2026-02-30', kind: 'off' }] },
    { exceptions: [{ date: '2026-12-01', kind: 'off' }, { date: '2026-12-01', kind: 'off' }] },
    { week: {} }, { exceptions: null }, { exceptions: [{ date: '2026-12-01', kind: 'bad' }] },
    { exceptions: [{ date: '2026-12-01', kind: 'extra', periods: [] }] },
    { exceptions: [{ date: '2026-12-01', kind: 'extra', periods: [{ start: '10:00', end: '11:00' }] }] },
    { week: { ...schedule.week, '1': null } },
  ]) expect(() => validateSchedule({ ...schedule, ...patch })).toThrow()
  const saved = validateSchedule({ ...schedule, exceptions: [{ date: '2026-10-26', kind: 'off' }] })
  expect(effectivePeriods(saved, '2026-10-26', '2026-10-24')).toEqual([])
  expect(effectivePeriods(saved, '2026-10-26', '2026-10-27')).toEqual(schedule.week['1'])
  expect(validateSchedule({ ...schedule, week: { ...schedule.week, '1': [{ start: '23:00', end: '24:00' }] } })).toBeDefined()
  for (const kind of ['morning-off', 'afternoon-off'] as const) {
    const value = validateSchedule({ ...schedule, exceptions: [{ date: '2026-10-26', kind }] })
    expect(effectivePeriods(value, '2026-10-26', '2026-10-24')).toEqual([schedule.week['1'][kind === 'morning-off' ? 1 : 0]])
  }
  expect(() => effectivePeriods(schedule, 'bad', '2026-10-24')).toThrow()
})

it('基础工作逐项确认、重开续做，默认不过目自动邀约；保存失败不伪装成功', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const initial = await loadGroundwork(store)
    expect(initial.invitation).toEqual({ mode: 'review', afterDays: 14 })
    expect(groundworkMissing(initial)).toContain('排班')
    const next = { ...initial, schedule: defaultSchedule(), checked: ['schedule'] }
    await saveGroundwork(store, next)
    expect(await loadGroundwork(store)).toEqual(next)
    expect(groundworkMissing(await loadGroundwork(store))).not.toContain('排班')
    for (const invitation of [{ mode: 'wrong', afterDays: 14 }, { mode: 'review', afterDays: 0 }, { mode: 'auto', afterDays: 1.5 }]) {
      await expect(saveGroundwork(store, { ...next, invitation } as never)).rejects.toThrow()
    }
    for (const patch of [{ checked: ['bad'] }, { checked: ['toString'] }, { checked: ['model', 'model'] }, { herbs: 'bad' }, { invitation: { mode: 'auto', afterDays: 3651 } }]) await expect(saveGroundwork(store, { ...next, ...patch } as never)).rejects.toThrow()
    await expect(saveGroundwork({ ...store, put: async () => { throw Error('SYNTHETIC_DISK') } }, next)).rejects.toThrow('没保存成功')
    expect(await loadGroundwork(store)).toEqual(next)
  } finally { store.close() }
})

it('新馆不能只勾选绕过，默认六项确认后可邀请；旧馆不重走，但仍提示补齐', async () => {
  const owner = createIdentity(), store = await openStore(owner, { factory: new IDBFactory() })
  try {
    await expect(assertInviteReady(store)).rejects.toThrow('6 项')
    await store.put('settings', 'hall', { openedAt: '2026-10-20T00:00:00Z', completedAt: null })
    await expect(assertInviteReady(store)).resolves.toBeUndefined()
    expect((await groundworkStatus(store)).missing).toHaveLength(6)
    const value = { ...await loadGroundwork(store), checked: Object.keys(GROUNDWORK_ITEMS) }
    await saveGroundwork(store, value)
    await expect(assertInviteReady(store)).rejects.toThrow('模板')
    for (const type of TEMPLATE_TYPES) await publishTemplate(store, (await saveTemplateDraft(store, type, '合成模板', defaultSchema(type))).id)
    await store.put('settings', 'personal-model', { provider: 'other', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic', apiKey: 'SYNTHETIC', testedAt: '2026-10-24T00:00:00Z' })
    await store.put('settings', 'retention-days', 90)
    expect((await groundworkStatus(store)).missing).toEqual([])
    await expect(assertInviteReady(store)).resolves.toBeUndefined()
    const role = await loadAgentRole(store, owner.publicKey, 'teacher')
    expect(role.invitation).toBe('review'); expect(role.template).toHaveProperty('record')
    await saveGroundwork(store, { ...value, herbs: 'pending' })
    await expect(assertInviteReady(store)).rejects.toThrow('药材库')
  } finally { store.close() }
})
