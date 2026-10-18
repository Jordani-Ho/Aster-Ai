import { getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { languages, type Identity, type Language } from '../identity'
import { base64, bytes, decryptRecord, deriveKey, encryptRecord, INFO, random, unbase64, validateAddress, validateRecord, type EncryptedRecord, type StoreValue } from './crypto'
import { openDatabase, readMeta, requestResult, transaction, writeMeta, type StoreOptions } from './database'
export type { StoreValue, JsonValue } from './crypto'
export type { StoreOptions } from './database'

interface Header { version: 1; owner: string; kdf: { alg: 'HKDF-SHA256'; salt: string; info: typeof INFO } }
interface WrappedIdentity { iv: string; ct: string; language: Language; account: number }
export interface EncryptedExport {
  format: 'aster-store-export'; version: 1; createdAt: string; owner: string
  kdf: Header['kdf']; cipher: 'AES-256-GCM'; includesBinary: boolean; records: EncryptedRecord[]
}
export class PasskeyUnlockRequired extends Error { constructor(){super('请刷脸解锁')} }
const recoveryMessage = '设备密钥不可用或身份数据损坏，请用助记词恢复'
const deviceAAD = (owner: string, language: Language, account: number) => new TextEncoder().encode(`aster/device-identity/v1\u0000${owner}\u0000${language}\u0000${account}`)
function validateHeader(input: unknown): Header {
  if (!input || typeof input !== 'object') throw new Error('存储格式或版本无效')
  const h = input as Header
  if (h.version !== 1 || !/^[0-9a-f]{64}$/.test(h.owner) || h.kdf?.alg !== 'HKDF-SHA256' || h.kdf.info !== INFO) throw new Error('存储格式或版本无效')
  unbase64(h.kdf.salt, 16)
  return { version: 1, owner: h.owner, kdf: { alg: 'HKDF-SHA256', salt: h.kdf.salt, info: INFO } }
}
function parseExport(input: unknown): EncryptedExport {
  const candidate = typeof input === 'string' ? JSON.parse(input) : input
  if (!candidate || typeof candidate !== 'object') throw new Error('导入格式无效')
  const a = candidate as EncryptedExport
  if (a.format !== 'aster-store-export' || a.version !== 1 || a.cipher !== 'AES-256-GCM') throw new Error('导入格式或版本不受支持')
  const header = validateHeader(a)
  if (typeof a.createdAt !== 'string' || !Number.isFinite(Date.parse(a.createdAt)) || typeof a.includesBinary !== 'boolean' || !Array.isArray(a.records)) throw new Error('导入格式无效')
  const records = a.records.map(validateRecord)
  const seen = new Set<string>()
  for (const r of records) {
    const address = `${r.c}\u0000${r.k}`
    if (seen.has(address) || (!a.includesBinary && r.bin)) throw new Error('导入记录重复或类型不符')
    seen.add(address)
  }
  return { format: 'aster-store-export', version: 1, createdAt: a.createdAt, owner: header.owner, kdf: header.kdf, cipher: 'AES-256-GCM', includesBinary: a.includesBinary, records }
}

const SCOPE = /^[a-z][a-z0-9_-]{0,40}$/
export class LocalStore {
  private pending: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(private db: IDBDatabase, private header: Header, private storageKey: CryptoKey, private privateKey: Uint8Array, private prefix = '', private ownsDb = true) {}
  // M1-22 家人子账户：同一个加密库里按“家人编号”分片，集合名加固定前缀，读写天然隔离；
  // 根实例导出/导入整库，所以一次备份、一次恢复覆盖全家。分片实例只做业务读写，不能导出、导入或关闭连接。
  scoped(prefix: string): LocalStore {
    if (!SCOPE.test(prefix)) throw new Error('家人存储前缀无效')
    return new LocalStore(this.db, this.header, this.storageKey, this.privateKey, prefix, false)
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
  private async assertCurrent(tx: IDBTransaction): Promise<void> {
    const current = validateHeader(await readMeta(tx, 'header'))
    if (current.owner !== this.header.owner || current.kdf.salt !== this.header.kdf.salt) throw new Error('存储状态已变化，请重新打开应用')
  }
  private async snapshot(): Promise<EncryptedRecord[]> {
    return transaction(this.db, ['meta', 'records'], 'readonly', async tx => {
      const recordsRequest = requestResult(tx.objectStore('records').getAll())
      await this.assertCurrent(tx)
      return (await recordsRequest).map(validateRecord)
    })
  }
  put(collection: string, key: string, value: StoreValue): Promise<void> {
    return this.enqueue(async () => {
      const address = this.address(collection)
      validateAddress(address, key)
      const encrypted = await encryptRecord(this.storageKey, address, key, value)
      await transaction(this.db, ['meta', 'records'], 'readwrite', async tx => {
        await this.assertCurrent(tx); tx.objectStore('records').put(encrypted)
      })
    })
  }
  get(collection: string, key: string): Promise<StoreValue | undefined> {
    return this.enqueue(async () => {
      const address = this.address(collection)
      validateAddress(address, key)
      const record = await transaction(this.db, ['meta', 'records'], 'readonly', async tx => {
        const requested = requestResult(tx.objectStore('records').get([address, key]))
        await this.assertCurrent(tx); return requested
      })
      return record === undefined ? undefined : decryptRecord(this.storageKey, record)
    })
  }
  list(collection: string): Promise<{ key: string; value: StoreValue }[]> {
    return this.enqueue(async () => {
      const address = this.address(collection)
      validateAddress(address, 'validation')
      const result = []
      // Camera files are large: ordinary settings/homework reads must not clone every video.
      const records = typeof IDBKeyRange === 'undefined' ? await this.snapshot() : await transaction(this.db, ['meta', 'records'], 'readonly', async tx => {
        const requested = requestResult(tx.objectStore('records').getAll(IDBKeyRange.bound([address, ''], [address, '\uffff'])))
        await this.assertCurrent(tx)
        return (await requested).map(validateRecord)
      })
      for (const record of records) if (record.c === address) result.push({ key: record.k, value: await decryptRecord(this.storageKey, record) })
      return result
    })
  }
  delete(collection: string, key: string): Promise<void> {
    return this.enqueue(async () => {
      const address = this.address(collection)
      validateAddress(address, key)
      await transaction(this.db, ['meta', 'records'], 'readwrite', async tx => { await this.assertCurrent(tx); tx.objectStore('records').delete([address, key]) })
    })
  }
  // 删除某个分片的全部记录（移除家人时清掉他的本机资料）。
  clearScope(prefix: string): Promise<void> {
    return this.enqueue(async () => {
      if (!SCOPE.test(prefix)) throw new Error('家人存储前缀无效')
      if (this.prefix !== '') throw new Error('只能在根存储上清理分片')
      const keys = (await this.snapshot()).filter(record => record.c.startsWith(prefix)).map(record => [record.c, record.k] as [string, string])
      if (keys.length === 0) return
      await transaction(this.db, ['meta', 'records'], 'readwrite', async tx => {
        await this.assertCurrent(tx)
        const records = tx.objectStore('records')
        for (const key of keys) records.delete(key)
      })
    })
  }
  exportEncrypted(options: { includeBinary?: boolean } = {}): Promise<EncryptedExport> {
    return this.enqueue(async () => {
      const records = await this.snapshot()
      // Verify the public bin flag against the authenticated encrypted type byte.
      for (const record of records) await decryptRecord(this.storageKey, record)
      return {
        format: 'aster-store-export', version: 1, createdAt: new Date().toISOString(), owner: this.header.owner,
        kdf: { ...this.header.kdf }, cipher: 'AES-256-GCM', includesBinary: options.includeBinary === true,
        records: records.filter(r => options.includeBinary === true || !r.bin),
      }
    })
  }
  importEncrypted(input: unknown, options: { replace?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      // Snapshot caller-owned input before awaiting crypto.
      const archive = parseExport(input)
      if (archive.owner !== this.header.owner) throw new Error('导入公钥与当前身份不一致')
      const importedKey = await deriveKey(this.privateKey, archive.kdf.salt)
      for (const record of archive.records) await decryptRecord(importedKey, record)
      const importedHeader: Header = { version: 1, owner: archive.owner, kdf: archive.kdf }
      await transaction(this.db, ['meta', 'records'], 'readwrite', async tx => {
        await this.assertCurrent(tx)
        const records = tx.objectStore('records')
        if (options.replace !== true && await requestResult(records.count()) > 0) throw new Error('已有本地数据，必须显式传入 replace: true')
        records.clear()
        for (const record of archive.records) records.put(record)
        writeMeta(tx, 'header', importedHeader)
      })
      // Switch salt/key only after the replacement transaction commits.
      this.header = importedHeader; this.storageKey = importedKey
    })
  }
  close(): void {
    this.closed = true
    // 分片实例不拥有数据库连接；关连接与擦私钥只在根实例做。
    if (!this.ownsDb) return
    void this.pending.finally(() => { this.privateKey.fill(0); this.db.close() })
  }
}

export async function openStore(identity: Identity, options: StoreOptions = {}): Promise<LocalStore> {
  if (getPublicKey(identity.privateKey) !== identity.publicKey) throw new Error('身份与私钥不匹配')
  const db = await openDatabase(options)
  try {
    const proposed: Header = { version: 1, owner: identity.publicKey, kdf: { alg: 'HKDF-SHA256', salt: base64(random(16)), info: INFO } }
    const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = random(12)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: deviceAAD(identity.publicKey, identity.language, identity.account), tagLength: 128 }, deviceKey, bytes(identity.privateKey))
    const wrapped: WrappedIdentity = { iv: base64(iv), ct: base64(new Uint8Array(ct)), language: identity.language, account: identity.account }
    const header = await transaction(db, ['meta'], 'readwrite', async tx => {
      const existing = await readMeta(tx, 'header')
      const selected = existing === undefined ? proposed : validateHeader(existing)
      if (selected.owner !== identity.publicKey) throw new Error('本地存储属于其他身份，请使用对应的助记词恢复')
      writeMeta(tx, 'header', selected); writeMeta(tx, 'deviceKey', deviceKey); writeMeta(tx, 'identity', wrapped)
      return selected
    })
    return new LocalStore(db, header, await deriveKey(identity.privateKey, header.kdf.salt), bytes(identity.privateKey))
  } catch (cause) { db.close(); throw cause }
}

export async function resumeStore(options: StoreOptions = {}): Promise<{ identity: Identity; store: LocalStore } | null> {
  const db = await openDatabase(options)
  let secret: Uint8Array<ArrayBuffer> | undefined
  try {
    const state = await transaction(db, ['meta'], 'readonly', async tx => {
      const [header, deviceKey, wrapped] = await Promise.all([readMeta<Header>(tx, 'header'), readMeta<CryptoKey | 'prf'>(tx, 'deviceKey'), readMeta<WrappedIdentity>(tx, 'identity')])
      return { header, deviceKey, wrapped }
    })
    if (!state.header && !state.deviceKey && !state.wrapped) { db.close(); return null }
    const header = validateHeader(state.header)
    if(state.deviceKey==='prf'&&!options.unlockKey)throw new PasskeyUnlockRequired()
    const deviceKey=state.deviceKey==='prf'?options.unlockKey:state.deviceKey
    if (!deviceKey || deviceKey.extractable !== false || deviceKey.algorithm.name !== 'AES-GCM' || !state.wrapped) throw new Error(recoveryMessage)
    const wrapped = state.wrapped
    if (!languages.includes(wrapped.language) || !Number.isSafeInteger(wrapped.account) || wrapped.account < 0 || wrapped.account >= 2 ** 31) throw new Error(recoveryMessage)
    secret = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(wrapped.iv, 12), additionalData: deviceAAD(header.owner, wrapped.language, wrapped.account), tagLength: 128 }, deviceKey, unbase64(wrapped.ct)))
    if (secret.length !== 32 || getPublicKey(secret) !== header.owner) throw new Error(recoveryMessage)
    const identity: Identity = { privateKey: secret, publicKey: header.owner, npub: npubEncode(header.owner), language: wrapped.language, account: wrapped.account }
    return { identity, store: new LocalStore(db, header, await deriveKey(secret, header.kdf.salt), bytes(secret)) }
  } catch (cause) { secret?.fill(0); db.close(); if(cause instanceof PasskeyUnlockRequired)throw cause;throw new Error(recoveryMessage) }
}

export async function clearStore(options:StoreOptions={}){await new Promise<void>((resolve,reject)=>{const request=(options.factory??indexedDB).deleteDatabase(options.name??'aster-local-store');request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('请关闭其他已打开的页面后重试。'))})}

export async function protectStore(identity:Identity,key:CryptoKey,options:StoreOptions={}){
 const db=await openDatabase(options)
 try{const iv=random(12),ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:deviceAAD(identity.publicKey,identity.language,identity.account),tagLength:128},key,bytes(identity.privateKey));const wrapped:WrappedIdentity={iv:base64(iv),ct:base64(new Uint8Array(ct)),language:identity.language,account:identity.account};await transaction(db,['meta'],'readwrite',async tx=>{const header=validateHeader(await readMeta(tx,'header'));if(header.owner!==identity.publicKey)throw Error('备份身份不匹配');writeMeta(tx,'identity',wrapped);writeMeta(tx,'deviceKey','prf')})}finally{db.close()}
}

export async function storeProtectionEnabled(options:StoreOptions={}){const db=await openDatabase(options);try{return await transaction(db,['meta'],'readonly',async tx=>(await readMeta(tx,'deviceKey'))==='prf')}finally{db.close()}}
