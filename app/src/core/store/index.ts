import { getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import type { Identity } from '../identity'
import { openDatabase, readMeta, requestResult, transaction, writeMeta, type StoreOptions } from './database'

// V2 本机存储：普通 IndexedDB 键值存取，不再加密。
// 值直接交给结构化克隆（对象/数组/Uint8Array 都可以），集合名与键名只保留原有字符约束。
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type StoreValue = JsonValue | Uint8Array
export type { StoreOptions } from './database'
export interface StoredIdentity { privateKey: string; publicKey: string; npub: string }

const NAME = /^[a-z][a-z0-9_-]{0,63}$/i
const KEY = /^[A-Za-z0-9_-]{1,64}$/

export function validateAddress(collection: unknown, key: unknown): asserts collection is string {
  if (typeof collection !== 'string' || !NAME.test(collection)) throw new Error('集合名必须是固定英文名')
  if (typeof key !== 'string' || !KEY.test(key)) throw new Error('键名必须是 1 至 64 位随机 ID，不得包含个人信息')
}
function hex(value: Uint8Array): string { return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('') }
function bytes(value: string): Uint8Array { return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)) }

const SCOPE = /^[a-z][a-z0-9_-]{0,40}$/
export class LocalStore {
  private pending: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(private db: IDBDatabase, private prefix = '', private ownsDb = true) {}
  // 家人子账户：同一个库里按“家人编号”把集合名加固定前缀，读写天然隔离。
  scoped(prefix: string): LocalStore {
    if (!SCOPE.test(prefix)) throw new Error('家人存储前缀无效')
    return new LocalStore(this.db, prefix, false)
  }
  private address(collection: string): string { return this.prefix + collection }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(() => {
      if (this.closed) throw new Error('存储已关闭，请重新打开')
      return operation()
    })
    this.pending = result.catch(() => {})
    return result
  }
  put(collection: string, key: string, value: StoreValue): Promise<void> {
    return this.enqueue(async () => {
      const address = this.address(collection)
      validateAddress(address, key)
      const copy = structuredClone(value) // 不可克隆的值在这里就报错，不留给 IndexedDB 半途失败。
      await transaction(this.db, ['records'], 'readwrite', async tx => { tx.objectStore('records').put({ c: address, k: key, v: copy }) })
    })
  }
  get(collection: string, key: string): Promise<StoreValue | undefined> {
    return this.enqueue(async () => {
      const address = this.address(collection)
      validateAddress(address, key)
      const record = await transaction(this.db, ['records'], 'readonly', async tx => requestResult(tx.objectStore('records').get([address, key])))
      return record === undefined ? undefined : structuredClone(record.v) as StoreValue
    })
  }
  list(collection: string): Promise<{ key: string; value: StoreValue }[]> {
    return this.enqueue(async () => {
      const address = this.address(collection)
      validateAddress(address, 'validation')
      const records = await transaction(this.db, ['records'], 'readonly', async tx => requestResult(tx.objectStore('records').index('c').getAll(address)))
      return records.map(record => ({ key: record.k, value: structuredClone(record.v) as StoreValue }))
    })
  }
  delete(collection: string, key: string): Promise<void> {
    return this.enqueue(async () => {
      const address = this.address(collection)
      validateAddress(address, key)
      await transaction(this.db, ['records'], 'readwrite', async tx => { tx.objectStore('records').delete([address, key]) })
    })
  }
  // 删除某个分片的全部记录（移除家人时清掉他的本机资料）。
  clearScope(prefix: string): Promise<void> {
    return this.enqueue(async () => {
      if (!SCOPE.test(prefix)) throw new Error('家人存储前缀无效')
      if (this.prefix !== '') throw new Error('只能在根存储上清理分片')
      const records = await transaction(this.db, ['records'], 'readonly', async tx => requestResult(tx.objectStore('records').getAll()))
      const keys = records.filter(record => record.c.startsWith(prefix)).map(record => [record.c, record.k] as [string, string])
      if (keys.length === 0) return
      await transaction(this.db, ['records'], 'readwrite', async tx => {
        const store = tx.objectStore('records')
        for (const key of keys) store.delete(key)
      })
    })
  }
  close(): void {
    this.closed = true
    // 分片实例不拥有数据库连接。
    if (!this.ownsDb) return
    void this.pending.finally(() => this.db.close())
  }
}

export function storedIdentity(identity: Identity): StoredIdentity {
  return { privateKey: hex(identity.privateKey), publicKey: identity.publicKey, npub: identity.npub }
}
export function identityFromStored(value: unknown): Identity | null {
  const record = value as Partial<StoredIdentity> | undefined
  if (!record || typeof record.privateKey !== 'string' || !/^[0-9a-f]{64}$/.test(record.privateKey)) return null
  const privateKey = bytes(record.privateKey)
  const publicKey = getPublicKey(privateKey)
  return { privateKey, publicKey, npub: npubEncode(publicKey) }
}

export async function openStore(identity: Identity, options: StoreOptions = {}): Promise<LocalStore> {
  const db = await openDatabase(options)
  try {
    await transaction(db, ['meta'], 'readwrite', async tx => {
      const existing = identityFromStored(await readMeta(tx, 'identity'))
      if (existing && existing.publicKey !== identity.publicKey) throw new Error('本地存储属于其他身份')
      writeMeta(tx, 'identity', storedIdentity(identity))
    })
    return new LocalStore(db)
  } catch (cause) { db.close(); throw cause }
}

export async function resumeStore(options: StoreOptions = {}): Promise<{ identity: Identity; store: LocalStore } | null> {
  const db = await openDatabase(options)
  try {
    const identity = identityFromStored(await transaction(db, ['meta'], 'readonly', async tx => readMeta(tx, 'identity')))
    if (!identity) { db.close(); return null }
    return { identity, store: new LocalStore(db) }
  } catch (cause) { db.close(); throw cause }
}

export async function clearStore(options: StoreOptions = {}) {
  await new Promise<void>((resolve, reject) => {
    const request = (options.factory ?? indexedDB).deleteDatabase(options.name ?? DEFAULT_DATABASE)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(Error('请关闭其他已打开的页面后重试。'))
  })
}

const DEFAULT_DATABASE = 'aster-local-store'
