import type { LocalStore, StoreValue } from '../store'
import { readTongue, type AbstractContext, type TransientPhoto } from '../abstractor'
import type { TongueCropCodec } from '../intake/photo'
import { cropTongue } from './crop'
import { parseTongueAbstract, tongueSvg, type TongueAbstract } from '../../../../domain/tcm/tongue'
import type { VisionClient } from '../llm/vision'
import { localDay } from '../homework/schedule'

// V2-08：舌头裁剪图作为第一层抽象留在本机。镜子只留最新一张；问诊的裁剪图走既有附件通道。
// 原图只存在于内存里的这一次调用中，裁剪后被清零，不写任何集合、不发中继。
export const TONGUE_COLLECTION = 'tongue-records'
export const TONGUE_CROPS = 'tongue-crops'

export interface TongueCropRow { id: string; at: string; data: Uint8Array }

export async function saveTongue(store: LocalStore, record: TongueAbstract, at = new Date(), crop?: Uint8Array): Promise<void> {
  const parsed = parseTongueAbstract(record)
  await store.put(TONGUE_COLLECTION, localDay(at), parsed as unknown as StoreValue)
  if (parsed.crop) {
    if (!(crop instanceof Uint8Array) || crop.length !== parsed.crop.bytes) throw new Error('舌头裁剪图与记录不一致')
    const row: TongueCropRow = { id: parsed.crop.id, at: at.toISOString(), data: crop }
    await store.put(TONGUE_CROPS, parsed.crop.id, row as unknown as StoreValue)
  }
  // 镜子连拍多天只留最新一张裁剪图；旧条目按要求提示“已被新图替换”。
  for (const row of await store.list(TONGUE_CROPS)) {
    if (row.key !== parsed.crop?.id) await store.delete(TONGUE_CROPS, row.key)
  }
}

// 读图 → 只裁框内 → 原图清零。失败（框太小/找不到舌头/模型不可用）不产生记录。
export async function captureTongue(
  photo: TransientPhoto,
  context: AbstractContext,
  model: VisionClient,
  options: { codec?: TongueCropCodec } = {},
): Promise<{ record: TongueAbstract; crop: Uint8Array }> {
  try {
    const reading = await readTongue(photo, context, model)
    const { ref, data } = await cropTongue(photo as { bytes: Uint8Array; type: string }, reading.box, options)
    const record: TongueAbstract = {
      kind: 'tongue', features: reading.features, svg: tongueSvg(reading.features),
      shichen: context.shichen, jieqi: context.jieqi, city: context.city,
      crop: ref,
      ...(reading.lightingNote ? { lightingNote: true as const } : {}),
    }
    return { record, crop: data }
  } finally {
    photo.bytes?.fill(0)
    photo.bytes = null
  }
}

export async function loadTongue(store: LocalStore, date: string): Promise<TongueAbstract | null> {
  const value = await store.get(TONGUE_COLLECTION, date)
  return value ? parseTongueAbstract(value) : null
}

export async function listTongueDays(store: LocalStore): Promise<string[]> {
  return (await store.list(TONGUE_COLLECTION)).map(row => row.key).sort()
}

// 镜子上唯一的裁剪图；记录里的 crop.id 对不上就是“已被新图替换”。
export async function latestTongueCrop(store: LocalStore): Promise<TongueCropRow | null> {
  const rows = await store.list(TONGUE_CROPS)
  let latest: TongueCropRow | null = null
  for (const row of rows) {
    const value = row.value as unknown as TongueCropRow | undefined
    if (!value || value.id !== row.key || !(value.data instanceof Uint8Array) || typeof value.at !== 'string') continue
    if (!latest || value.at > latest.at) latest = value
  }
  return latest
}
