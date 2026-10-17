export type PersistenceStatus = 'requesting' | 'granted' | 'denied' | 'unsupported' | 'error'
export async function requestPersistence(manager?: Pick<StorageManager, 'persist'>): Promise<PersistenceStatus> {
  if (!manager || typeof manager.persist !== 'function') return 'unsupported'
  try { return await manager.persist() ? 'granted' : 'denied' } catch { return 'error' }
}
export const persistenceLabels: Record<PersistenceStatus, string> = {
  requesting: '正在申请持久化存储', granted: '已获准持久化存储', denied: '浏览器未授予持久化存储，数据可能被自动清理',
  unsupported: '此浏览器不支持持久化存储申请', error: '持久化存储申请失败',
}
