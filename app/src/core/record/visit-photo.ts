import { processPhoto, type PhotoInput, type PhotoCodec, type PhotoResult } from '../intake/photo'
export const VISIT_MAX_PHOTOS = 3
export const VISIT_PHOTO_MAX_BYTES = 400 * 1024
/** 患处照片只用于交还，禁止送入视觉模型。 */
export async function processVisitPhoto(input: PhotoInput, options: { codec?: PhotoCodec; existingCount?: number } = {}): Promise<PhotoResult> {
  const count = options.existingCount ?? 0
  if (!Number.isSafeInteger(count) || count < 0) throw Error('照片数量无效')
  if (count >= VISIT_MAX_PHOTOS) throw Error('最多只能添加 3 张患处照片')
  return processPhoto(input, { codec: options.codec, existingCount: count, maxBytes: VISIT_PHOTO_MAX_BYTES })
}
