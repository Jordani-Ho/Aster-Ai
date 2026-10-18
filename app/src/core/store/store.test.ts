import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { clearStore, openStore, resumeStore, type LocalStore } from './index'

const handles: LocalStore[] = []
const factory = new IDBFactory()
const key = '728f7cfa-19aa-470d-a4e3-313f15574e28'
const secondKey = '3a3e3d36-20a0-4b44-a456-31f9353e2ef1'
const fixture = { note: 'synthetic-private-note', nested: [true, null, 123] }

async function open(name: string, who = createIdentity()): Promise<LocalStore> {
  const store = await openStore(who, { name, factory })
  handles.push(store)
  return store
}

afterEach(() => { handles.splice(0).forEach(store => store.close()) })

describe('V2 local key-value store on fake-indexeddb', () => {
  it('1: puts, gets, lists and deletes values in one collection', async () => {
    const store = await open(crypto.randomUUID())
    await store.put('notes', key, fixture)
    expect(await store.get('notes', key)).toEqual(fixture)
    await store.put('notes', secondKey, 'synthetic-second')
    expect((await store.list('notes')).sort((left, right) => left.key.localeCompare(right.key))).toEqual([
      { key: secondKey, value: 'synthetic-second' },
      { key, value: fixture },
    ])
    await store.delete('notes', key)
    expect(await store.get('notes', key)).toBeUndefined()
    expect(await store.list('notes')).toEqual([{ key: secondKey, value: 'synthetic-second' }])
  })

  it('2: round-trips binary values without encryption', async () => {
    const store = await open(crypto.randomUUID())
    const data = new Uint8Array(256 * 1024).fill(123)
    await store.put('media', key, data)
    expect(await store.get('media', key)).toEqual(data)
    await store.delete('media', key)
    expect(await store.get('media', key)).toBeUndefined()
  })

  it('3: keeps scoped collections isolated from the root and from each other', async () => {
    const store = await open(crypto.randomUUID())
    const dad = store.scoped('f1-'), kid = store.scoped('f2-')
    await store.put('homework', key, 'synthetic-owner-work')
    await dad.put('homework', key, 'synthetic-dad-work')
    await kid.put('homework', secondKey, 'synthetic-kid-work')
    expect((await store.list('homework')).map(row => row.value)).toEqual(['synthetic-owner-work'])
    expect((await dad.list('homework')).map(row => row.value)).toEqual(['synthetic-dad-work'])
    expect((await kid.list('homework')).map(row => row.value)).toEqual(['synthetic-kid-work'])
  })

  it('4: clears one scope and validates scope prefixes', async () => {
    const store = await open(crypto.randomUUID())
    const dad = store.scoped('f1-')
    await dad.put('homework', key, 'synthetic-dad-work')
    await store.put('homework', key, 'synthetic-owner-work')
    await store.clearScope('f1-')
    expect(await dad.list('homework')).toEqual([])
    expect((await store.list('homework')).map(row => row.value)).toEqual(['synthetic-owner-work'])
    expect(() => store.scoped('Bad.Scope')).toThrow('家人存储前缀无效')
    await expect(store.clearScope('bad.prefix')).rejects.toThrow('家人存储前缀无效')
    await expect(dad.clearScope('f1-')).rejects.toThrow('只能在根存储上清理分片')
  })

  it('5: refuses to open the same database for a different identity', async () => {
    const name = crypto.randomUUID()
    const identity = createIdentity()
    const store = await open(name, identity)
    await store.put('notes', key, fixture)
    await expect(openStore(createIdentity(), { name, factory })).rejects.toThrow('本地存储属于其他身份')
    expect(await store.get('notes', key)).toEqual(fixture)
  })

  it('6: resumes a closed database and reads every value back', async () => {
    const name = crypto.randomUUID()
    const identity = createIdentity()
    const store = await open(name, identity)
    await store.put('notes', key, fixture)
    store.close()
    expect(await resumeStore({ name: crypto.randomUUID(), factory })).toBeNull()
    const session = await resumeStore({ name, factory })
    expect(session).not.toBeNull()
    handles.push(session!.store)
    expect(session!.identity.publicKey).toBe(identity.publicKey)
    expect(session!.identity.npub).toBe(identity.npub)
    expect(await session!.store.get('notes', key)).toEqual(fixture)
  })

  it('7: clearStore deletes the database so a fresh start has no identity', async () => {
    const name = crypto.randomUUID()
    const store = await open(name)
    await store.put('notes', key, fixture)
    store.close()
    await clearStore({ name, factory })
    expect(await resumeStore({ name, factory })).toBeNull()
  })

  it('8: rejects invalid collection and key names', async () => {
    const store = await open(crypto.randomUUID())
    for (const bad of ['私人姓名', 'a'.repeat(65), '', 'a\u0000b']) await expect(store.put('notes', bad, fixture)).rejects.toThrow()
    await expect(store.put('个人资料', key, fixture)).rejects.toThrow()
    await expect(store.get('notes!', key)).rejects.toThrow()
    await expect(store.list('个人资料')).rejects.toThrow()
  })

  it('9: rejects values that cannot be structured-cloned', async () => {
    const store = await open(crypto.randomUUID())
    for (const bad of [() => {}, Symbol('synthetic'), new WeakMap()]) {
      await expect(store.put('notes', secondKey, bad as never)).rejects.toThrow()
    }
    expect(await store.get('notes', secondKey)).toBeUndefined()
  })

  it('10: refuses every operation after close', async () => {
    const store = await open(crypto.randomUUID())
    await store.put('notes', key, fixture)
    store.close()
    await expect(store.get('notes', key)).rejects.toThrow('存储已关闭，请重新打开')
    await expect(store.put('notes', secondKey, fixture)).rejects.toThrow('存储已关闭，请重新打开')
    await expect(store.list('notes')).rejects.toThrow('存储已关闭，请重新打开')
    await expect(store.delete('notes', key)).rejects.toThrow('存储已关闭，请重新打开')
  })
})
