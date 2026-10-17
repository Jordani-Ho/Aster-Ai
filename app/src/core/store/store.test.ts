import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
import { deriveKey, encryptRecord } from './crypto'
import { createIdentity } from '../identity'
import { openStore, resumeStore, type LocalStore } from './index'
import { requestPersistence } from './persistence'

const phrase = 'leader monkey parrot ring guide accident before fence cannon height naive bean'
const identity = () => createIdentity(phrase, 'english')
const other = () => createIdentity(phrase, 'english', 1)
const handles: LocalStore[] = []
const key = '728f7cfa-19aa-470d-a4e3-313f15574e28'
const secondKey = '3a3e3d36-20a0-4b44-a456-31f9353e2ef1'
const fixture = { note: 'synthetic-private-note', nested: [true, null, 123] }
function setup() {
  const factory = new IDBFactory()
  const options = { name: crypto.randomUUID(), factory }
  const open = async (who = identity()) => { const store = await openStore(who, options); handles.push(store); return store }
  return { options, open }
}
async function raw(options: { name: string; factory: IDBFactory }, storeName: string, change?: (store: IDBObjectStore) => void): Promise<any[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = options.factory.open(options.name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, change ? 'readwrite' : 'readonly')
      const store = tx.objectStore(storeName)
      change?.(store)
      const r = store.getAll()
      tx.oncomplete = () => resolve(r.result)
      tx.onabort = () => reject(tx.error)
    })
  } finally { db.close() }
}
afterEach(() => { handles.splice(0).forEach(store => store.close()) })

describe('M1-02 acceptance with fake-indexeddb', () => {
  it('1: writes ciphertext only, with no plaintext value or private key in raw storage', async () => {
    const { open, options } = setup(); const store = await open()
    await store.put('notes', key, fixture)
    const serialized = JSON.stringify([await raw(options, 'records'), await raw(options, 'meta')])
    expect(serialized).not.toContain(fixture.note)
    expect(serialized).not.toContain('nested')
    expect(serialized).not.toContain(Buffer.from(identity().privateKey).toString('hex'))
    expect(await store.get('notes', key)).toEqual(fixture)
  })
  it('2: rejects a wrong identity/key explicitly without returning data', async () => {
    const { open } = setup(); const store = await open(); await store.put('notes', key, fixture)
    await expect(open(other())).rejects.toThrow(/身份|密钥/)
    await expect(open({ ...identity(), privateKey: other().privateKey })).rejects.toThrow(/身份|密钥/)
  })
  it('rejects records encrypted by a wrong key even when address and owner metadata match', async () => {
    const { open, options } = setup(); const store = await open(); await store.put('notes', key, fixture)
    const archive = await store.exportEncrypted()
    const wrongKey = await deriveKey(other().privateKey, archive.kdf.salt)
    const wrongRecord = await encryptRecord(wrongKey, 'notes', key, fixture)
    await raw(options, 'records', s => s.put(wrongRecord))
    await expect(store.get('notes', key)).rejects.toThrow('记录解密认证失败：密钥错误或数据已损坏')
  })
  it('3: exports, deletes the database, imports and restores all records across salts', async () => {
    const { open, options } = setup(); const store = await open()
    await store.put('notes', key, fixture); await store.put('media', secondKey, new Uint8Array([0, 255, 7]))
    const archive = await store.exportEncrypted({ includeBinary: true }); store.close()
    await new Promise<void>((resolve, reject) => { const r = options.factory.deleteDatabase(options.name); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error) })
    const restored = await open(); await restored.importEncrypted(archive, { replace: true })
    expect(await restored.get('notes', key)).toEqual(fixture)
    expect(await restored.get('media', secondKey)).toEqual(new Uint8Array([0, 255, 7]))
    expect((await restored.exportEncrypted({ includeBinary: true })).records).toEqual(archive.records)
  })
  it('4: uses fresh IVs for repeated plaintext writes', async () => {
    const { open, options } = setup(); const store = await open()
    await store.put('notes', key, fixture); const first = (await raw(options, 'records'))[0]
    await store.put('notes', key, fixture); const second = (await raw(options, 'records'))[0]
    expect(first.iv).not.toBe(second.iv); expect(first.ct).not.toBe(second.ct)
  })
  it('5: runs collection CRUD in the CI IndexedDB environment', async () => {
    const { open } = setup(); const store = await open()
    await store.put('notes', key, fixture); await store.put('other', secondKey, false)
    expect(await store.list('notes')).toEqual([{ key, value: fixture }])
    await store.delete('notes', key)
    expect(await store.get('notes', key)).toBeUndefined(); expect(await store.list('notes')).toEqual([])
    expect(await store.get('other', secondKey)).toBe(false)
  })
  it('6: fails authentication if a ciphertext is moved to another key or collection', async () => {
    const { open, options } = setup(); const store = await open(); await store.put('notes', key, fixture)
    const record = (await raw(options, 'records'))[0]
    await raw(options, 'records', s => { s.put({ ...record, k: secondKey }); s.put({ ...record, c: 'other' }) })
    await expect(store.get('notes', secondKey)).rejects.toThrow(/解密|认证/)
    await expect(store.get('other', key)).rejects.toThrow(/解密|认证/)
  })
  it('7: rejects another owner and keeps local data unchanged', async () => {
    const { open } = setup(); const store = await open(); await store.put('notes', key, fixture)
    const before = await store.exportEncrypted(); const archive = { ...before, owner: other().publicKey }
    await expect(store.importEncrypted(archive, { replace: true })).rejects.toThrow(/公钥|身份/)
    expect((await store.exportEncrypted()).records).toEqual(before.records)
  })
  it('8: rejects a tampered final record without replacing any local data', async () => {
    const { open } = setup(); const store = await open()
    await store.put('notes', key, fixture); await store.put('notes', secondKey, 'synthetic-second')
    const archive = await store.exportEncrypted(); const bad = structuredClone(archive)
    bad.records[1].ct = (bad.records[1].ct[0] === 'A' ? 'B' : 'A') + bad.records[1].ct.slice(1)
    await expect(store.importEncrypted(bad, { replace: true })).rejects.toThrow(/解密|认证/)
    expect((await store.exportEncrypted()).records).toEqual(archive.records)
  })
  it('9: round-trips JSON and binary and excludes binary by default without re-encrypting', async () => {
    const { open } = setup(); const store = await open()
    await store.put('notes', key, fixture); await store.put('media', secondKey, new Uint8Array([0, 255]))
    expect(await store.get('media', secondKey)).toEqual(new Uint8Array([0, 255]))
    const full = await store.exportEncrypted({ includeBinary: true })
    expect((await store.exportEncrypted()).records).toEqual(full.records.filter(r => !r.bin))
    expect((await store.exportEncrypted({ includeBinary: false })).includesBinary).toBe(false)
  })
  it('round-trips a photo-sized binary value and rejects values that cannot round-trip as JSON', async () => {
    const { open } = setup(); const store = await open()
    const data = new Uint8Array(256 * 1024).fill(123)
    await store.put('media', key, data)
    expect(Buffer.from(await store.get('media', key) as Uint8Array).equals(Buffer.from(data))).toBe(true)
    const archive = await store.exportEncrypted({ includeBinary: true })
    await store.importEncrypted(archive, { replace: true })
    expect(Buffer.from(await store.get('media', key) as Uint8Array).equals(Buffer.from(data))).toBe(true)
    for (const bad of [undefined, NaN, Infinity, new Date(), { absent: undefined }]) await expect(store.put('notes', secondKey, bad as any)).rejects.toThrow()
  })
  it('10: rejects Chinese or overlong IDs and non-English collections', async () => {
    const { open } = setup(); const store = await open()
    for (const bad of ['私人姓名', 'a'.repeat(65), '', 'a\u0000b']) await expect(store.put('notes', bad, fixture)).rejects.toThrow()
    await expect(store.put('个人资料', key, fixture)).rejects.toThrow()
  })
  it('11: resumes after closing with a nonextractable device key, without a mnemonic', async () => {
    const { open, options } = setup(); const store = await open(); await store.put('notes', key, fixture); store.close()
    const session = await resumeStore(options); expect(session).not.toBeNull(); handles.push(session!.store)
    expect(session!.identity.publicKey).toBe(identity().publicKey)
    expect(await session!.store.get('notes', key)).toEqual(fixture)
    const deviceKey = (await raw(options, 'meta')).find(item => item.k === 'deviceKey').value as CryptoKey
    expect(deviceKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', deviceKey)).rejects.toThrow()
  })
  it('12: missing device key requires mnemonic recovery; recovery preserves data', async () => {
    const { open, options } = setup(); const store = await open(); await store.put('notes', key, fixture); store.close()
    await raw(options, 'meta', s => s.delete('deviceKey'))
    await expect(resumeStore(options)).rejects.toThrow('请用助记词恢复')
    const recovered = await open(); expect(await recovered.get('notes', key)).toEqual(fixture)
  })
  it.each(['account', 'language'] as const)('requires mnemonic recovery after wrapped identity %s is tampered with', async field => {
    const { open, options } = setup(); const store = await open()
    await store.put('notes', key, fixture); store.close()
    const wrapped = (await raw(options, 'meta')).find(item => item.k === 'identity')
    const changed = { ...wrapped, value: { ...wrapped.value, [field]: field === 'account' ? 7 : 'simplified' } }
    await raw(options, 'meta', s => s.put(changed))
    const outcome = await resumeStore(options).then(session => {
      session?.store.close(); session?.identity.privateKey.fill(0)
      return 'unexpected success'
    }, (cause: Error) => cause.message)
    expect(outcome).toContain('请用助记词恢复')
    const recovered = await open()
    expect(await recovered.get('notes', key)).toEqual(fixture)
  })
  it('preserves authenticated language and account when resuming a child identity', async () => {
    const { open, options } = setup(); const owner = other(); const store = await open(owner); store.close()
    const session = await resumeStore(options); expect(session).not.toBeNull(); handles.push(session!.store)
    expect(session!.identity.language).toBe(owner.language)
    expect(session!.identity.account).toBe(1)
    expect(session!.identity.publicKey).toBe(owner.publicKey)
    session!.identity.privateKey.fill(0)
  })
  it('refuses unknown formats/versions and replacement without explicit confirmation', async () => {
    const { open } = setup(); const store = await open(); await store.put('notes', key, fixture)
    const archive = await store.exportEncrypted()
    await expect(store.importEncrypted(archive)).rejects.toThrow(/replace/)
    for (const bad of [{ ...archive, format: 'unknown' }, { ...archive, version: 2 }]) await expect(store.importEncrypted(bad, { replace: true })).rejects.toThrow(/格式|版本/)
    expect(await store.get('notes', key)).toEqual(fixture)
  })
  it('authenticates binary metadata and rejects duplicate import keys', async () => {
    const { open } = setup(); const store = await open(); await store.put('notes', key, fixture)
    const archive = await store.exportEncrypted()
    const bad = structuredClone(archive); bad.records[0].bin = true; bad.includesBinary = true
    await expect(store.importEncrypted(bad, { replace: true })).rejects.toThrow()
    await expect(store.importEncrypted({ ...archive, records: [...archive.records, ...archive.records] }, { replace: true })).rejects.toThrow()
  })
  it('rolls back both records and salt if a replacement write fails mid-transaction', async () => {
    const source = setup(); const target = setup()
    const backup = await source.open(); const store = await target.open()
    await backup.put('notes', key, fixture); await backup.put('notes', secondKey, 'synthetic-second')
    await store.put('existing', key, 'synthetic-original')
    const before = await store.exportEncrypted(); const incoming = await backup.exportEncrypted()
    const original = FakeObjectStore.prototype.put
    let writes = 0
    const spy = vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'records' && ++writes === 2) throw new DOMException('Synthetic quota failure', 'QuotaExceededError')
      return original.apply(this, args)
    })
    try { await expect(store.importEncrypted(incoming, { replace: true })).rejects.toThrow('Synthetic quota failure') }
    finally { spy.mockRestore() }
    const after = await store.exportEncrypted()
    expect(after.records).toEqual(before.records); expect(after.kdf).toEqual(before.kdf)
  })
  it('detects a salt replacement made by another session before writing stale ciphertext', async () => {
    const target = setup(); const source = setup()
    const store = await target.open(); const stale = await target.open(); const backup = await source.open()
    await backup.put('notes', key, fixture)
    await store.importEncrypted(await backup.exportEncrypted(), { replace: true })
    await expect(stale.put('notes', secondKey, 'synthetic')).rejects.toThrow(/状态已变化/)
    expect(await store.get('notes', key)).toEqual(fixture)
  })
  it('reports granted, denied, unavailable and failing persistence requests', async () => {
    expect(await requestPersistence({ persist: async () => true })).toBe('granted')
    expect(await requestPersistence({ persist: async () => false })).toBe('denied')
    expect(await requestPersistence(undefined)).toBe('unsupported')
    expect(await requestPersistence({ persist: async () => { throw new Error('synthetic') } })).toBe('error')
  })
})
