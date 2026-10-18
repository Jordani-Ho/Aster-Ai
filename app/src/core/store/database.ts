export const DEFAULT_DATABASE = 'aster-local-store'
export interface StoreOptions { name?: string; factory?: IDBFactory }
export function openDatabase(options: StoreOptions): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = options.factory ?? globalThis.indexedDB
    if (!factory) { reject(new Error('此浏览器不支持 IndexedDB')); return }
    const request = factory.open(options.name ?? DEFAULT_DATABASE, 1)
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore('records', { keyPath: ['c', 'k'] })
      records.createIndex('c', 'c', { unique: false })
      request.result.createObjectStore('meta', { keyPath: 'k' })
    }
    request.onerror = () => reject(request.error ?? new Error('无法打开本地存储'))
    request.onblocked = () => reject(new Error('存储被其他页面占用，请关闭其他页面后重试'))
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
  })
}
export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
}
export async function transaction<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const tx = db.transaction(stores, mode)
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('本地存储事务已中止'))
    tx.onerror = () => reject(tx.error ?? new Error('本地存储事务失败'))
  })
  // Handle an abort even while body is still awaiting a failed request.
  void done.catch(() => {})
  try { const result = await body(tx); await done; return result }
  catch (cause) { try { tx.abort() } catch { /* Already aborted or complete. */ } await done.catch(() => {}); throw cause }
}
export async function readMeta<T>(tx: IDBTransaction, key: string): Promise<T | undefined> {
  const record = await requestResult(tx.objectStore('meta').get(key))
  return record?.value as T | undefined
}
export function writeMeta(tx: IDBTransaction, key: string, value: unknown): void {
  tx.objectStore('meta').put({ k: key, value })
}
