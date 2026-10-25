import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { assessPrescriptionStock, adjustHerb, cleanSharedHomeHerbs, createHerb, deductPrescription, deleteHerb, HERB_LEDGER, listHerbs, loadHerbUnits, lowStockHerbs, matchPrescriptionToInventory, normalizeHerbName, parsePrescriptionDose, prescriptionStockNotes, receiveHerb, reversePrescription, saveHerbUnits, setHerbEnabled, snapshotHomeHerbs, studentHerbReminders, toSmallestUnit, validateHerbAmount, validateHerbUnit, validateHerbUnits } from './index'

it('名称全角转半角并去空格；单位、数量、警戒线、换算和 100 千克逐项校验', () => {
  expect(normalizeHerbName('  黄　芪 ')).toBe('黄芪')
  expect(() => normalizeHerbName('  ')).toThrow()
  for (const unit of ['克', '钱', '两', '片', '枚', '个']) expect(() => validateHerbUnit(unit)).not.toThrow()
  expect(() => validateHerbUnit('公斤')).toThrow()
  expect(validateHerbAmount(0, '克', true)).toBe(0)
  for (const value of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => validateHerbAmount(value, '克')).toThrow()
  expect(validateHerbAmount(0.1, '克')).toBe(1)
  expect(() => validateHerbAmount(0.01, '克')).toThrow()
  expect(() => validateHerbAmount(100_000.1, '克')).toThrow()
  expect(() => validateHerbUnits({ qianInTenthsGram: 0, liangInTenthsGram: -1 })).toThrow()
  expect(() => toSmallestUnit(1, '钱', { qianInTenthsGram: null, liangInTenthsGram: null })).toThrow('确认')
  expect(toSmallestUnit(1, '钱', { qianInTenthsGram: 35, liangInTenthsGram: 350 })).toBe(35)
  expect(toSmallestUnit(1, '两', { qianInTenthsGram: 35, liangInTenthsGram: 350 })).toBe(350)
  expect(cleanSharedHomeHerbs([{ name: ' 全角　黄芪 ', status: '够', quantity: 987 }])).toEqual([{ name: '全角黄芪', status: '够' }])
  expect(() => cleanSharedHomeHerbs([{ name: '药材', status: '够', quantity: 1 }, { name: '', status: '够' }])).toThrow()
})

it('500 克入库、30 克扣减、余额和流水正确；同名不能重复建，低库存按警戒线提示', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const herb = await createHerb(store, { id: 'herb-a', name: '黄芪', unit: '克', threshold: 100, at: '2026-10-24T00:00:00Z' })
    await expect(createHerb(store, { id: 'herb-b', name: ' 黄　芪 ', unit: '克', threshold: 0 })).rejects.toThrow('同名')
    const inbound = await receiveHerb(store, herb.id, 500, { qianInTenthsGram: null, liangInTenthsGram: null }, 'purchase-1', 'receive-1')
    expect(inbound).toMatchObject({ delta: 5000, reason: '入库', balanceAfter: 5000 })
    const deduction = await deductPrescription(store, [{ herb: '黄　芪', quantity: 30, unit: '克' }], 'record-1', 'rx-1')
    expect(deduction.shortages).toEqual([])
    expect(deduction.entries[0]).toMatchObject({ delta: -300, reason: '开方扣减', balanceAfter: 4700 })
    expect(await listHerbs(store)).toMatchObject([{ quantity: 4700 }])
    expect((await store.list(HERB_LEDGER)).map(row => (row.value as { balanceAfter: number }).balanceAfter).sort((a, b) => a - b)).toEqual([4700, 5000])
    expect(await lowStockHerbs(store)).toEqual([])
    await adjustHerb(store, herb.id, -4500, '合成盘点差异', 'adjust-1')
    expect((await lowStockHerbs(store))[0].quantity).toBe(200)
  } finally { store.close() }
})

it('一味药短缺时整方不扣并报差额；重复开方 key 只写一遍，方中同味药合并', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const a = await createHerb(store, { id: 'herb-a', name: '合成甲', unit: '克', threshold: 0 })
    const b = await createHerb(store, { id: 'herb-b', name: '合成乙', unit: '克', threshold: 0 })
    await receiveHerb(store, a.id, 10, { qianInTenthsGram: null, liangInTenthsGram: null }, 'purchase-a', 'in-a')
    await receiveHerb(store, b.id, 1, { qianInTenthsGram: null, liangInTenthsGram: null }, 'purchase-b', 'in-b')
    const shortage = await deductPrescription(store, [
      { herb: a.name, quantity: 2, unit: '克' }, { herb: a.name, quantity: 2, unit: '克' }, { herb: b.name, quantity: 4, unit: '克' },
    ], 'record-short', 'rx-short')
    expect(shortage.entries).toEqual([])
    expect(shortage.shortages).toEqual([{ herb: '合成乙', missing: 3, unit: '克' }])
    expect((await listHerbs(store)).map(herb => herb.quantity)).toEqual([100, 10])
    const good = await deductPrescription(store, [{ herb: a.name, quantity: 2, unit: '克' }, { herb: a.name, quantity: 2, unit: '克' }], 'record-good', 'rx-good')
    expect(good.entries).toHaveLength(1)
    expect(good.entries[0]).toMatchObject({ delta: -40, balanceAfter: 60 })
    expect((await deductPrescription(store, [{ herb: a.name, quantity: 2, unit: '克' }], 'record-good', 'rx-good')).entries).toEqual([])
    expect((await listHerbs(store)).find(herb => herb.id === a.id)?.quantity).toBe(60)
  } finally { store.close() }
})

it('停用药材不能入库或扣减；复用前启用；调整不能扣成负数', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const herb = await createHerb(store, { id: 'herb-a', name: '停用药', unit: '片', threshold: 0 })
    await receiveHerb(store, herb.id, 5, { qianInTenthsGram: null, liangInTenthsGram: null }, 'purchase', 'in-1')
    await setHerbEnabled(store, herb.id, false)
    await expect(receiveHerb(store, herb.id, 1, { qianInTenthsGram: null, liangInTenthsGram: null }, 'purchase', 'in-2')).rejects.toThrow('停用')
    await expect(deductPrescription(store, [{ herb: herb.name, quantity: 1, unit: '片' }], 'record', 'rx')).rejects.toThrow('停用')
    await setHerbEnabled(store, herb.id, true)
    await expect(adjustHerb(store, herb.id, -60, '合成盘点', 'adjust')).rejects.toThrow('不足')
    expect((await listHerbs(store))[0].quantity).toBe(5)
  } finally { store.close() }
})

it('钱、两换算配置可更改并读取；相同流水 key 幂等', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    expect(await loadHerbUnits(store)).toEqual({ qianInTenthsGram: null, liangInTenthsGram: null })
    await expect(saveHerbUnits(store, { qianInTenthsGram: 0, liangInTenthsGram: 350 })).rejects.toThrow()
    await saveHerbUnits(store, { qianInTenthsGram: 35, liangInTenthsGram: 350 })
    expect(await loadHerbUnits(store)).toEqual({ qianInTenthsGram: 35, liangInTenthsGram: 350 })
    const herb = await createHerb(store, { id: 'herb-a', name: '合成钱药', unit: '钱', threshold: 0 })
    await expect(receiveHerb(store, herb.id, 1, await loadHerbUnits(store), 'purchase', 'same-key')).resolves.toMatchObject({ delta: 35 })
    await expect(receiveHerb(store, herb.id, 1, await loadHerbUnits(store), 'purchase', 'same-key')).resolves.toBeNull()
    expect((await listHerbs(store))[0].quantity).toBe(35)
    const rx = matchPrescriptionToInventory([{ herb: herb.name, quantity: 3.5, unit: '克' }], await listHerbs(store), await loadHerbUnits(store))
    expect(rx).toEqual([{ herb: herb.name, quantity: 1, unit: '钱' }])
    await receiveHerb(store, herb.id, 1, await loadHerbUnits(store), 'purchase-2', 'in-2')
    const shortage = await deductPrescription(store, [{ herb: herb.name, quantity: 3, unit: '钱' }], 'rx-short', 'rx-short-key', { units: await loadHerbUnits(store) })
    expect(shortage.shortages).toEqual([{ herb: herb.name, missing: 1, unit: '钱' }])
    expect(await prescriptionStockNotes(store, [{ herb: '库里没有的合成药', dose: '2g' }])).toEqual(['库里没有库里没有的合成药'])
  } finally { store.close() }
})

it('签字方作废按原流水冲回一次；有流水的药材不能硬删', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const herb = await createHerb(store, { id: 'herb-a', name: '合成冲回药', unit: '克', threshold: 0 })
    await receiveHerb(store, herb.id, 20, { qianInTenthsGram: null, liangInTenthsGram: null }, 'purchase', 'in-1')
    await deductPrescription(store, [{ herb: herb.name, quantity: 3, unit: '克' }], 'signed-event', 'rx-event')
    expect(await reversePrescription(store, 'signed-event', 'void-event')).toMatchObject([{ herb: herb.id, delta: 30, reason: '作废冲回', balanceAfter: 200 }])
    expect(await reversePrescription(store, 'signed-event', 'void-event')).toEqual([])
    expect(await reversePrescription(store, 'signed-event', 'different-retry-key')).toEqual([])
    expect((await listHerbs(store))[0].quantity).toBe(200)
    await expect(deleteHerb(store, herb.id)).rejects.toThrow('有过流水')
  } finally { store.close() }
})

it('远程问诊自动附上可核算的数量；老师按每剂标够几剂、差额或另抓', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const enough = await createHerb(store, { id: 'herb-a', name: '合成家中药', unit: '克', threshold: 50 })
    const low = await createHerb(store, { id: 'herb-b', name: '合成将尽药', unit: '克', threshold: 5 })
    const unsupported = await createHerb(store, { id: 'herb-c', name: '合成钱药', unit: '钱', threshold: 0 })
    const disabled = await createHerb(store, { id: 'herb-d', name: '停用药材', unit: '克', threshold: 0 })
    await receiveHerb(store, enough.id, 10, { qianInTenthsGram: null, liangInTenthsGram: null }, 'purchase', 'in-1')
    await receiveHerb(store, low.id, 2, { qianInTenthsGram: null, liangInTenthsGram: null }, 'purchase', 'in-2')
    await setHerbEnabled(store, disabled.id, false)
    const snapshot = snapshotHomeHerbs(await listHerbs(store), await loadHerbUnits(store))
    expect(snapshot).toHaveLength(2)
    expect(snapshot).toEqual(expect.arrayContaining([{ name: '合成家中药', quantity: 10, unit: '克' }, { name: '合成将尽药', quantity: 2, unit: '克' }]))
    expect(snapshot.some(item => item.name === unsupported.name || item.name === disabled.name)).toBe(false)
    expect(assessPrescriptionStock([
      { herb: '合成家中药', dose: '3克' }, { herb: '库里没有', dose: '1克' }, { herb: '合成将尽药', dose: '3克' },
    ], snapshot, await loadHerbUnits(store))).toEqual([
      { herb: '合成家中药', text: '家里有 10 克，够 3 剂', kind: 'enough' },
      { herb: '库里没有', text: '要另抓 1克', kind: 'buy' },
      { herb: '合成将尽药', text: '家里不够，差 1 克', kind: 'shortage' },
    ])
    expect(studentHerbReminders(await listHerbs(store), await loadHerbUnits(store), [{ herb: '合成将尽药', dose: '3克' }])).toContain('合成将尽药不够下一剂，差 1 克')
    expect(parsePrescriptionDose('合成家中药', '3g')).toEqual({ herb: '合成家中药', quantity: 3, unit: '克' })
    expect(() => parsePrescriptionDose('合成家中药', '每次少许')).toThrow('无法识别')
    expect(cleanSharedHomeHerbs([{ name: '合成旧格式药', status: '够' }])).toEqual([{ name: '合成旧格式药', status: '够' }])
    expect(cleanSharedHomeHerbs([{ name: '合成新格式药', quantity: 0, unit: '克' }])).toEqual([{ name: '合成新格式药', quantity: 0, unit: '克' }])
    expect(() => cleanSharedHomeHerbs([{ name: '合成有效药', quantity: 2, unit: '克' }, { name: '合成坏数据', quantity: -1, unit: '克' }])).toThrow()
  } finally { store.close() }
})

it('钱、两配置未确认时不发无法计算的余量；配置后按老师换算精确对照', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const herb = await createHerb(store, { id: 'herb-qian', name: '合成钱剂', unit: '钱', threshold: 0 })
    expect(snapshotHomeHerbs(await listHerbs(store), await loadHerbUnits(store))).toEqual([])
    await saveHerbUnits(store, { qianInTenthsGram: 35, liangInTenthsGram: 350 })
    await receiveHerb(store, herb.id, 2, await loadHerbUnits(store), 'purchase', 'qian-in')
    const snapshot = snapshotHomeHerbs(await listHerbs(store), await loadHerbUnits(store))
    expect(snapshot).toEqual([{ name: '合成钱剂', quantity: 2, unit: '钱' }])
    expect(assessPrescriptionStock([{ herb: '合成钱剂', dose: '3.5克' }], snapshot, await loadHerbUnits(store))).toEqual([
      { herb: '合成钱剂', text: '家里有 7 克，够 2 剂', kind: 'enough' },
    ])
    expect(assessPrescriptionStock([{ herb: '合成钱剂', dose: '3.5克' }], snapshot, { qianInTenthsGram: null, liangInTenthsGram: null })[0].kind).toBe('unknown')
  } finally { store.close() }
})
