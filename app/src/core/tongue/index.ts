import type { LocalStore, StoreValue } from '../store'
import { readTongue, type AbstractContext, type TransientPhoto } from '../abstractor'
import { processPhoto, type PhotoCodec, type TongueCropCodec } from '../intake/photo'
import { cropTongue, planTongueCrop } from './crop'
import { parseTongueAbstract, tongueCropMinShortSide, tongueSvg, type TongueAbstract } from '../../../../domain/tcm/tongue'
import type { VisionClient } from '../llm/vision'
import { localDay } from '../homework/schedule'
import { isTongueFailure, TONGUE_TOO_FAR_MESSAGE, tongueFailure } from './failures'

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

export interface CaptureTongueOptions {
  /** 裁剪用编解码；测试注入合成实现。 */
  codec?: TongueCropCodec
  /** 送模型前的规范化（processPhoto）编解码；测试注入合成实现。 */
  photoCodec?: PhotoCodec
  /** 测试用：关掉“模型暂时连不上自动重试一次”。 */
  noModelRetry?: boolean
}

// V2-20：送模型前先规范化 —— 长边 ≤1600、重编码成 JPEG、去 EXIF；
// image/jpg、大小写、空 type 都由浏览器解码 + 重编码兜住；浏览器解不开（HEIC 等）报“格式打不开”。
async function prepareTonguePhoto(photo: { bytes: Uint8Array; type: string }, photoCodec?: PhotoCodec): Promise<{ bytes: Uint8Array; type: 'image/jpeg'; width: number; height: number }> {
  try {
    const result = await processPhoto({ bytes: photo.bytes, type: photo.type }, { codec: photoCodec })
    return { bytes: result.data, type: 'image/jpeg', width: result.image.width, height: result.image.height }
  } catch (error) {
    if (isTongueFailure(error)) throw error
    throw tongueFailure('photo_format')
  }
}

async function readWithRetry(prepared: { bytes: Uint8Array; type: string }, context: AbstractContext, model: VisionClient, noRetry: boolean | undefined) {
  try {
    return await readTongue({ bytes: prepared.bytes, type: prepared.type }, context, model)
  } catch (error) {
    if (!isTongueFailure(error) || !error.retryable || noRetry) throw error
    // 网络、超时、5xx：自动再试一次，用户无感；还失败才把这一档交给界面。
    return await readTongue({ bytes: prepared.bytes, type: prepared.type }, context, model)
  }
}

// 读图 → 只裁框内 → 原图清零。失败（格式/没拍到/太远/模型不可用）不产生记录，调用方记失败类别。
export async function captureTongue(
  photo: TransientPhoto,
  context: AbstractContext,
  model: VisionClient,
  options: CaptureTongueOptions = {},
): Promise<{ record: TongueAbstract; crop: Uint8Array }> {
  const original = photo.bytes
  let prepared: { bytes: Uint8Array; type: string; width: number; height: number } | null = null
  try {
    if (!(original instanceof Uint8Array)) throw tongueFailure('photo_format')
    prepared = await prepareTonguePhoto({ bytes: original, type: photo.type }, options.photoCodec)
    const reading = await readWithRetry(prepared, context, model, options.noModelRetry)
    // V2-20：门槛改成“裁剪后短边 ≥160 像素”（值在 domain/tcm/tongue-features.json），不再按画面面积。
    const plan = planTongueCrop(reading.box, prepared.width, prepared.height)
    if (Math.min(plan.source.width, plan.source.height) < tongueCropMinShortSide()) throw tongueFailure('no_tongue', TONGUE_TOO_FAR_MESSAGE)
    let cropped: { ref: TongueAbstract['crop']; data: Uint8Array }
    try {
      const { ref, data } = await cropTongue({ bytes: prepared.bytes, type: prepared.type }, reading.box, { codec: options.codec })
      cropped = { ref, data }
    } catch (error) {
      if (isTongueFailure(error)) throw error
      throw tongueFailure('photo_format')
    }
    const record: TongueAbstract = {
      kind: 'tongue', features: reading.features, svg: tongueSvg(reading.features),
      shichen: context.shichen, jieqi: context.jieqi, city: context.city,
      crop: cropped.ref,
      ...(reading.lightingNote ? { lightingNote: true as const } : {}),
    }
    return { record, crop: cropped.data }
  } finally {
    prepared?.bytes.fill(0)
    original?.fill(0)
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
