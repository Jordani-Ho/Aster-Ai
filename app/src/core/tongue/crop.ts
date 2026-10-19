import { browserTongueCropCodec, randomId, sha256Hex, type TongueCropCodec } from '../intake/photo'
import type { TongueBox, TongueCropRef } from '../../../../domain/tcm/tongue'

// V2-08 第一级抽象：只裁舌头框内的像素，长边 ≤512，JPEG。
// 原图不落盘、不外发；裁剪后由调用方当场把原图字节清零。
export const TONGUE_CROP_LONG_SIDE = 512
const JPEG_QUALITY = 0.8

export interface TongueCropPlan { source: { x: number; y: number; width: number; height: number }; output: { width: number; height: number } }

// 相对框 → 像素矩形 + 输出尺寸。只在框内取样，不放大、不拉伸比例。
export function planTongueCrop(box: TongueBox, width: number, height: number): TongueCropPlan {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error('图片尺寸无效')
  const x = Math.max(0, Math.min(width - 1, Math.round(box.x * width)))
  const y = Math.max(0, Math.min(height - 1, Math.round(box.y * height)))
  const cropWidth = Math.max(1, Math.min(width - x, Math.round(box.width * width)))
  const cropHeight = Math.max(1, Math.min(height - y, Math.round(box.height * height)))
  const longSide = Math.max(cropWidth, cropHeight)
  const scale = longSide <= TONGUE_CROP_LONG_SIDE ? 1 : TONGUE_CROP_LONG_SIDE / longSide
  return {
    source: { x, y, width: cropWidth, height: cropHeight },
    output: { width: Math.max(1, Math.round(cropWidth * scale)), height: Math.max(1, Math.round(cropHeight * scale)) },
  }
}

// 返回裁剪图字节与附件引用；调用方负责随后清原图。codec 可注入，测试用合成图。
export async function cropTongue(
  input: { bytes: Uint8Array; type: string },
  box: TongueBox,
  options: { codec?: TongueCropCodec } = {},
): Promise<{ ref: TongueCropRef; data: Uint8Array }> {
  if (!input || !(input.bytes instanceof Uint8Array) || input.bytes.length === 0) throw new Error('没拍清舌头，请靠近一点重拍。')
  const codec = options.codec ?? browserTongueCropCodec()
  if (!codec) throw new Error('没拍清舌头，请靠近一点重拍。')
  const decoded = await codec.decode(input.bytes, input.type || 'image/jpeg')
  try {
    const plan = planTongueCrop(box, decoded.width, decoded.height)
    const canvas = codec.crop(decoded.source, plan.source, plan.output)
    const data = await canvas.toJpeg(JPEG_QUALITY)
    return {
      ref: { id: randomId(16), type: 'photo', sha256: await sha256Hex(data), bytes: data.length },
      data,
    }
  } finally {
    // 解码出来的位图只是裁剪用的临时副本，裁完立刻释放。
    ;(decoded.source as { close?: () => void }).close?.()
  }
}
