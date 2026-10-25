import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import type { Encounter } from './types'
import { startInPersonEncounter } from './in-person'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { createHerb, HERB_LEDGER, listHerbs, receiveHerb } from '../herbs'
import { signAndHandoverInPersonWithHerbs } from './in-person-herbs'
import { loadGroundwork, saveGroundwork } from '../hall/groundwork'

const now = new Date('2026-10-25T08:00:00.000Z')

function withPrescription(teacher: string, items: { herb: string; dose: string }[]): Encounter {
  const encounter = startInPersonEncounter({ teacher, student: getPublicKey(generateSecretKey()), now, id: 'a'.repeat(32) })
  return {
    ...encounter,
    plan: { ...encounter.plan, prescription: { value: { items }, source: 'teacher' } },
  }
}

async function fixture() {
  const teacher = createIdentity()
  const store = await openStore(teacher, { factory: new IDBFactory() })
  const sent: string[] = []
  const sign = (items: { herb: string; dose: string }[]) => signAndHandoverInPersonWithHerbs({
    encounter: withPrescription(teacher.publicKey, items),
    privateKey: teacher.privateKey, store,
    send: async (_type, event) => { sent.push(event.id) },
  })
  return { teacher, store, sent, sign }
}

async function setHerbChoice(store: Awaited<ReturnType<typeof openStore>>, herbs: 'none' | 'ready') {
  await saveGroundwork(store, { ...await loadGroundwork(store), herbs })
}

it('不备药仍能签字交还，不扣库存也不提示', async () => {
  const f = await fixture()
  try {
    const herb = await createHerb(f.store, { id: 'herb-a', name: '合成黄芪', unit: '克', threshold: 0 })
    await receiveHerb(f.store, herb.id, 100, { qianInTenthsGram: null, liangInTenthsGram: null }, '合成入库', 'receive-a')
    await setHerbChoice(f.store, 'none')
    const result = await f.sign([{ herb: herb.name, dose: '3克' }])
    expect(result.signed.id).toBe(f.sent.at(-1))
    expect(result.inventoryNotice).toBeNull()
    expect((await listHerbs(f.store))[0].quantity).toBe(1000)
    expect((await f.store.list(HERB_LEDGER)).map(row => (row.value as { reason: string }).reason)).toEqual(['入库'])
    expect(await f.store.list('teacher-records')).toHaveLength(1)
  } finally { f.store.close() }
})

it('库存不足时仍签字交还，整方不扣并在签后提示差额', async () => {
  const f = await fixture()
  try {
    await setHerbChoice(f.store, 'ready')
    const herb = await createHerb(f.store, { id: 'herb-b', name: '合成黄芪', unit: '克', threshold: 0 })
    await receiveHerb(f.store, herb.id, 10, { qianInTenthsGram: null, liangInTenthsGram: null }, '合成入库', 'receive-b')
    const result = await f.sign([{ herb: herb.name, dose: '12克' }])
    expect(result.signed.id).toBe(f.sent.at(-1))
    expect(result.inventoryNotice).toContain('库存不足，这张方子没扣库存')
    expect(result.inventoryNotice).toContain('合成黄芪差 2克')
    expect(result.inventoryNotice).toContain('药材库里手动扣')
    expect((await listHerbs(f.store))[0].quantity).toBe(100)
    expect((await f.store.list(HERB_LEDGER)).map(row => (row.value as { reason: string }).reason)).toEqual(['入库'])
    expect(await f.store.list('teacher-records')).toHaveLength(1)
  } finally { f.store.close() }
})

it('库存充足时仍按原规则扣减后签字交还', async () => {
  const f = await fixture()
  try {
    await setHerbChoice(f.store, 'ready')
    const herb = await createHerb(f.store, { id: 'herb-c', name: '合成黄芪', unit: '克', threshold: 0 })
    await receiveHerb(f.store, herb.id, 50, { qianInTenthsGram: null, liangInTenthsGram: null }, '合成入库', 'receive-c')
    const result = await f.sign([{ herb: herb.name, dose: '20克' }])
    expect(result.signed.id).toBe(f.sent.at(-1))
    expect(result.inventoryNotice).toBeNull()
    expect((await listHerbs(f.store))[0].quantity).toBe(300)
    const ledger = (await f.store.list(HERB_LEDGER)).map(row => row.value as { reason: string; delta: number })
    expect(ledger).toHaveLength(2)
    expect(ledger).toContainEqual(expect.objectContaining({ reason: '开方扣减', delta: -200 }))
    expect(await f.store.list('teacher-records')).toHaveLength(1)
  } finally { f.store.close() }
})

it('库外药不提示；库内剂量解析不了时跳过并在签后提示', async () => {
  const f = await fixture()
  try {
    await setHerbChoice(f.store, 'ready')
    const herb = await createHerb(f.store, { id: 'herb-d', name: '合成黄芪', unit: '克', threshold: 0 })
    await receiveHerb(f.store, herb.id, 50, { qianInTenthsGram: null, liangInTenthsGram: null }, '合成入库', 'receive-d')
    const result = await f.sign([{ herb: herb.name, dose: '适量' }, { herb: '库外合成药', dose: '3克' }])
    expect(result.signed.id).toBe(f.sent.at(-1))
    expect(result.inventoryNotice).toContain('剂量无法识别')
    expect(result.inventoryNotice).toContain('合成黄芪')
    expect(result.inventoryNotice).not.toContain('库外合成药')
    expect((await listHerbs(f.store))[0].quantity).toBe(500)
    expect(await f.store.list('teacher-records')).toHaveLength(1)
  } finally { f.store.close() }
})

it('签字发送失败时仍按已写流水冲回库存', async () => {
  const f = await fixture()
  try {
    await setHerbChoice(f.store, 'ready')
    const herb = await createHerb(f.store, { id: 'herb-e', name: '合成黄芪', unit: '克', threshold: 0 })
    await receiveHerb(f.store, herb.id, 50, { qianInTenthsGram: null, liangInTenthsGram: null }, '合成入库', 'receive-e')
    await expect(signAndHandoverInPersonWithHerbs({
      encounter: withPrescription(f.teacher.publicKey, [{ herb: herb.name, dose: '20克' }]),
      privateKey: f.teacher.privateKey, store: f.store,
      send: async () => { throw Error('offline') },
    })).rejects.toThrow('offline')
    expect((await listHerbs(f.store))[0].quantity).toBe(500)
    const ledger = (await f.store.list(HERB_LEDGER)).map(row => row.value as { reason: string; delta: number })
    expect(ledger).toContainEqual(expect.objectContaining({ reason: '开方扣减', delta: -200 }))
    expect(ledger).toContainEqual(expect.objectContaining({ reason: '作废冲回', delta: 200 }))
    expect(await f.store.list('teacher-records')).toHaveLength(0)
  } finally { f.store.close() }
})
