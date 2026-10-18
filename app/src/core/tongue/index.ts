import type { LocalStore, StoreValue } from '../store'
import type { HeavenStamp } from '../heaven'
import { processPhoto, type PhotoCodec, type PhotoInput } from '../intake/photo'
import { addDays, localDay } from '../homework/schedule'

// 舌象日记：每天最多一张，复用 intake/photo.ts 压缩去 EXIF（长边 ≤1600、JPEG、无元数据），
// 只存本机（V2 起不加密）。M1 只存与列，不做自动分析。
export const TONGUE_COLLECTION = 'tongue-photos'

export interface TongueRecord {
  bytes: Uint8Array
  /** 拍这张时的天时（V2-02 第 5 条）；老调用不传时为 null。 */
  heaven: HeavenStamp | null
}

export interface TonguePhoto {
  date: string
  bytes: Uint8Array
}

export interface SaveTongueOptions {
  codec?: PhotoCodec
  now?: () => Date
  heaven?: HeavenStamp
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

// 同一天再拍会覆盖当天早前那张（“每天最多一张，只保留最后一张”）。
export async function saveTonguePhoto(
  store: LocalStore,
  input: PhotoInput,
  options: SaveTongueOptions = {},
): Promise<{ date: string; ref: { id: string; sha256: string } }> {
  const result = await processPhoto(input, { codec: options.codec })
  const date = localDay(options.now?.() ?? new Date())
  const record: TongueRecord = { bytes: result.data, heaven: options.heaven ?? null }
  await store.put(TONGUE_COLLECTION, date, record as unknown as StoreValue)
  return { date, ref: { id: result.ref.id, sha256: result.ref.sha256 } }
}

export async function tongueRecord(store: LocalStore, date: string): Promise<TongueRecord | null> {
  if (!DAY.test(date)) throw new Error('日期须为 YYYY-MM-DD')
  const value = await store.get(TONGUE_COLLECTION, date)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<TongueRecord>
  return record.bytes instanceof Uint8Array ? { bytes: record.bytes, heaven: record.heaven ?? null } : null
}

export async function tongueBytes(store: LocalStore, date: string): Promise<Uint8Array | null> {
  return (await tongueRecord(store, date))?.bytes ?? null
}

// 按日期升序列出有记录的日期。
export async function listTongueDays(store: LocalStore): Promise<string[]> {
  const rows = await store.list(TONGUE_COLLECTION)
  return rows.map(row => row.key).filter(key => DAY.test(key)).sort()
}

// 最近 N 天（含今天）的舌象，供界面做缩略列表（字节即压缩后的 JPEG，界面直接小图渲染）。
export async function recentTongue(store: LocalStore, days = 30, now = new Date()): Promise<TonguePhoto[]> {
  if (!Number.isInteger(days) || days <= 0) throw new Error('天数无效')
  const cutoff = localDay(addDays(now, -(days - 1)))
  const result: TonguePhoto[] = []
  for (const date of await listTongueDays(store)) {
    if (date < cutoff) continue
    const bytes = await tongueBytes(store, date)
    if (bytes) result.push({ date, bytes })
  }
  return result
}
