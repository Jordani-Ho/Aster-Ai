import type { LocalStore } from '../store'
import { processPhoto, type PhotoCodec, type PhotoInput } from '../intake/photo'
import { addDays, localDay } from '../homework/schedule'

// 舌象日记：每天最多一张，复用 intake/photo.ts 压缩去 EXIF（长边 ≤1600、JPEG、无元数据），
// 加密存本机（字节进 LocalStore 的 bin 记录）。M1 只存与列，不做自动分析。
export const TONGUE_COLLECTION = 'tongue-photos'

export interface TonguePhoto {
  date: string
  bytes: Uint8Array
}

export interface SaveTongueOptions {
  codec?: PhotoCodec
  now?: () => Date
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
  await store.put(TONGUE_COLLECTION, date, result.data)
  return { date, ref: { id: result.ref.id, sha256: result.ref.sha256 } }
}

export async function tongueBytes(store: LocalStore, date: string): Promise<Uint8Array | null> {
  if (!DAY.test(date)) throw new Error('日期须为 YYYY-MM-DD')
  const value = await store.get(TONGUE_COLLECTION, date)
  return value instanceof Uint8Array ? value : null
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
