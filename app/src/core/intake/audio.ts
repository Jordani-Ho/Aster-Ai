import type { AttachmentRef } from '../record/types'
import { randomId, sha256Hex } from './photo'

export const AUDIO_MIME_TYPES = ['audio/mp4', 'audio/webm', 'audio/ogg'] as const
export const MAX_AUDIO_SEGMENT_MS = 3 * 60 * 1000
export const MAX_AUDIO_TOTAL_MS = 10 * 60 * 1000
// 以约 24 kbit/s 录制，确保单个加密附件留在中继单条消息限制内。
export const MAX_AUDIO_SEGMENT_BYTES = 950_000
export const MAX_AUDIO_TOTAL_BYTES = 2_500_000

export interface AudioClip { ref: AttachmentRef; data: Uint8Array }

export function validateAudioLimits(mimeType: string, durationMs: number, bytes: number, totals: { durationMs?: number; bytes?: number } = {}): void {
  if (!(AUDIO_MIME_TYPES as readonly string[]).includes(mimeType)) throw new Error('录音格式暂不支持，请用文字继续')
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_AUDIO_SEGMENT_MS) throw new Error('单段录音不能超过 3 分钟')
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_AUDIO_SEGMENT_BYTES) throw new Error('录音体积超过限制，请分段或改用文字')
  const totalDuration = (totals.durationMs ?? 0) + durationMs
  if (!Number.isSafeInteger(totalDuration) || totalDuration > MAX_AUDIO_TOTAL_MS) throw new Error('一次问诊录音不能超过 10 分钟')
  const totalBytes = (totals.bytes ?? 0) + bytes
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_AUDIO_TOTAL_BYTES) throw new Error('本次录音合计体积超过限制，请改用文字')
}

export async function createAudioAttachment(data: Uint8Array, mimeType: string, durationMs: number, totals: { durationMs?: number; bytes?: number } = {}): Promise<AudioClip> {
  if (!(data instanceof Uint8Array)) throw new Error('录音内容无效')
  validateAudioLimits(mimeType, durationMs, data.length, totals)
  return {
    ref: { id: randomId(16), type: 'audio', sha256: await sha256Hex(data), bytes: data.length, mimeType: mimeType as AttachmentRef['mimeType'], durationMs },
    data,
  }
}

export function isSupportedAudioMime(mimeType: string): mimeType is (typeof AUDIO_MIME_TYPES)[number] {
  return (AUDIO_MIME_TYPES as readonly string[]).includes(mimeType)
}
