import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { createHerb, listHerbs, receiveHerb } from './index'
import { brewOneWithStudentAgent, getStudentHerbAdvice } from './agent'
import type { Prescription } from '../record/types'

const nullUnits = { qianInTenthsGram: null, liangInTenthsGram: null }
const rx = (dose: string): Prescription => ({ items: [{ herb: '合成黄芪', dose }], method: '', days: 1 })

it('学生智能体接到一次煎药操作只扣根库存一次；新操作可再扣，家人分片不各建库存', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const herb = await createHerb(store, { id: 'root-herb', name: '合成黄芪', unit: '克', threshold: 0 })
    await receiveHerb(store, herb.id, 100, nullUnits, 'purchase', 'root-in')
    const familyStore = store.scoped('f1-')
    const encounterId = 'a'.repeat(32), actionId = 'b'.repeat(32)
    const first = await brewOneWithStudentAgent(store, encounterId, rx('30克'), actionId, new Date('2026-10-25T09:00:00'))
    const replay = await brewOneWithStudentAgent(store, encounterId, rx('30克'), actionId, new Date('2026-10-25T09:01:00'))
    expect(first.deducted).toBe(1)
    expect(replay).toEqual(first)
    expect((await listHerbs(store))[0].quantity).toBe(700)
    expect(await listHerbs(familyStore)).toEqual([])

    const second = await brewOneWithStudentAgent(store, encounterId, rx('30克'), 'c'.repeat(32), new Date('2026-10-25T09:02:00'))
    expect(second.deducted).toBe(1)
    expect((await listHerbs(store))[0].quantity).toBe(400)
  } finally { store.close() }
})

it('库存不足不扣；剂量解析不了的药跳过并提示，不影响可解析药材扣减', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const herb = await createHerb(store, { id: 'root-herb', name: '合成黄芪', unit: '克', threshold: 0 })
    await receiveHerb(store, herb.id, 20, nullUnits, 'purchase', 'root-in')
    const short = await brewOneWithStudentAgent(store, 'a'.repeat(32), rx('30克'), 'b'.repeat(32))
    expect(short).toMatchObject({ deducted: 0, shortages: [{ herb: '合成黄芪', missing: 10, unit: '克' }] })
    expect((await listHerbs(store))[0].quantity).toBe(200)

    const mixed: Prescription = { items: [{ herb: '合成黄芪', dose: '2克' }, { herb: '合成无法识别药', dose: '少许' }], method: '', days: 1 }
    const result = await brewOneWithStudentAgent(store, 'c'.repeat(32), mixed, 'd'.repeat(32))
    expect(result.deducted).toBe(1)
    expect(result.skipped).toEqual(['合成无法识别药剂量无法识别，跳过扣减：少许'])
    expect((await listHerbs(store))[0].quantity).toBe(180)
  } finally { store.close() }
})

it('学生智能体在打开记录时按当前方子对照根库存并提醒低库存或下一剂差额', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const herb = await createHerb(store, { id: 'root-herb', name: '合成黄芪', unit: '克', threshold: 25 })
    await receiveHerb(store, herb.id, 20, nullUnits, 'purchase', 'root-in')
    const advice = await getStudentHerbAdvice(store, rx('30克'), new Date('2026-10-25T09:00:00'))
    expect(advice.labels).toEqual([{ herb: '合成黄芪', text: '家里不够，差 10 克', kind: 'shortage' }])
    expect(advice.reminders).toContain('合成黄芪库存偏低，剩余 20 克')
    expect(advice.reminders).toContain('合成黄芪不够下一剂，差 10 克')
  } finally { store.close() }
})
