import type { AttachmentRef } from '../record/types'

// 手机拍照：长边缩到 ≤1600 像素、JPEG 质量 0.8，重新编码并去掉 EXIF（含 GPS）。
// 每张处理后 ≤500 KB，最多 4 张。不新增依赖，只用浏览器自带的 canvas 能力。

export const MAX_PHOTOS = 4
export const MAX_LONG_SIDE = 1600
export const MAX_BYTES = 500 * 1024
const QUALITY_STEPS = [0.8, 0.6, 0.4] as const

export interface PhotoInput { bytes: Uint8Array; type: string }
export interface PhotoCanvas { toJpeg(quality: number): Promise<Uint8Array> }
export interface PhotoCodec {
  decode(bytes: Uint8Array, type: string): Promise<{ source: unknown; width: number; height: number }>
  draw(source: unknown, width: number, height: number): PhotoCanvas
}
export interface PhotoResult { ref: AttachmentRef; data: Uint8Array }

export function assertPhotoCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('照片数量无效')
  if (count >= MAX_PHOTOS) throw new Error('最多只能添加 ' + MAX_PHOTOS + ' 张照片')
}

// 长边不超过上限时保持原尺寸；否则按比例缩小，宽高至少为 1。
export function planResize(width: number, height: number, maxLongSide: number = MAX_LONG_SIDE): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error('图片尺寸无效')
  if (!Number.isSafeInteger(maxLongSide) || maxLongSide <= 0) throw new Error('图片尺寸上限无效')
  const longSide = Math.max(width, height)
  if (longSide <= maxLongSide) return { width, height }
  const scale = maxLongSide / longSide
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

// JPEG 段扫描：去掉 APP1（EXIF/XMP，含 GPS 信息），其余段和扫描数据原样保留。
// 即使浏览器编码器已经去掉元数据，这一步也再做一次，保证输出里一定没有 EXIF。
export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array) || input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) throw new Error('不是 JPEG 图片')
  const out: number[] = [0xff, 0xd8]
  let offset = 2
  while (offset + 1 < input.length) {
    if (input[offset] !== 0xff) throw new Error('JPEG 段格式无效')
    let markerOffset = offset
    while (markerOffset < input.length && input[markerOffset] === 0xff) markerOffset += 1
    if (markerOffset >= input.length) throw new Error('JPEG 段格式无效')
    const marker = input[markerOffset]
    const afterMarker = markerOffset + 1
    if (marker === 0xd9) { out.push(0xff, 0xd9); return Uint8Array.from(out) }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(0xff, marker); offset = afterMarker; continue }
    if (marker === 0xda) {
      // 熵编码的扫描数据从 SOS 起原样复制到文件尾（其中不会再出现可解析的元数据段）。
      for (let index = markerOffset - 1; index < input.length; index += 1) out.push(input[index])
      return Uint8Array.from(out)
    }
    if (afterMarker + 1 >= input.length) throw new Error('JPEG 段长度无效')
    const length = (input[afterMarker] << 8) | input[afterMarker + 1]
    if (length < 2 || afterMarker + length > input.length) throw new Error('JPEG 段长度无效')
    // 0xE1 是 APP1（EXIF/XMP）；去掉整段。
    if (marker !== 0xe1) {
      out.push(0xff, marker)
      for (let index = afterMarker; index < afterMarker + length; index += 1) out.push(input[index])
    }
    offset = afterMarker + length
  }
  throw new Error('JPEG 缺少结束标记')
}

function browserCodec(): PhotoCodec | null {
  if (typeof createImageBitmap !== 'function') return null
  const hasOffscreenCanvas = typeof OffscreenCanvas === 'function'
  if (!hasOffscreenCanvas && typeof document === 'undefined') return null
  return {
    async decode(bytes, type) {
      const buffer = bytes.slice().buffer as ArrayBuffer
      const bitmap = await createImageBitmap(new Blob([buffer], { type }))
      return { source: bitmap, width: bitmap.width, height: bitmap.height }
    },
    draw(source, width, height) {
      if (hasOffscreenCanvas) {
        const canvas = new OffscreenCanvas(width, height)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('浏览器无法绘制图片')
        context.drawImage(source as ImageBitmap, 0, 0, width, height)
        return {
          async toJpeg(quality) {
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
            return new Uint8Array(await blob.arrayBuffer())
          },
        }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法绘制图片')
      context.drawImage(source as ImageBitmap, 0, 0, width, height)
      return {
        toJpeg(quality) {
          return new Promise<Uint8Array>((resolve, reject) => {
            canvas.toBlob(blob => {
              if (!blob) { reject(new Error('浏览器无法编码图片')); return }
              void blob.arrayBuffer().then(buffer => resolve(new Uint8Array(buffer))).catch(reject)
            }, 'image/jpeg', quality)
          })
        },
      }
    },
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function randomId(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

// 处理一张照片：解码 → 缩放 → 逐级降质量重编码 → 去元数据 → 校验大小，返回 AttachmentRef 与处理后字节。
export async function processPhoto(input: PhotoInput, options: { codec?: PhotoCodec; existingCount?: number } = {}): Promise<PhotoResult> {
  if (!input || !(input.bytes instanceof Uint8Array) || input.bytes.length === 0) throw new Error('照片内容为空')
  assertPhotoCount(options.existingCount ?? 0)
  const codec = options.codec ?? browserCodec()
  if (!codec) throw new Error('当前浏览器不支持照片处理')
  const decoded = await codec.decode(input.bytes, input.type || 'image/jpeg')
  const size = planResize(decoded.width, decoded.height)
  const canvas = codec.draw(decoded.source, size.width, size.height)
  let data: Uint8Array | null = null
  for (const quality of QUALITY_STEPS) {
    const encoded = await canvas.toJpeg(quality)
    const clean = stripJpegMetadata(encoded)
    if (clean.length <= MAX_BYTES) { data = clean; break }
  }
  if (!data) throw new Error('照片压缩后仍超过 500 KB，请重拍或换一张')
  return {
    ref: { id: randomId(16), type: 'photo', sha256: await sha256Hex(data), bytes: data.length },
    data,
  }
}
