import { describe, expect, it } from 'vitest'
import { createAudioAttachment, MAX_AUDIO_SEGMENT_BYTES, MAX_AUDIO_SEGMENT_MS, MAX_AUDIO_TOTAL_BYTES, MAX_AUDIO_TOTAL_MS } from './audio'

describe('V2-26 audio validation', () => {
  it('accepts the iPhone and Huawei recording formats and creates a verified attachment reference', async () => {
    for (const mimeType of ['audio/mp4', 'audio/webm'] as const) {
      const clip = await createAudioAttachment(new Uint8Array([1, 2, 3]), mimeType, 1200)
      expect(clip.ref).toMatchObject({ type: 'audio', mimeType, durationMs: 1200, bytes: 3 })
      expect(clip.ref.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('rejects an audio MIME type outside the allowlist', async () => {
    await expect(createAudioAttachment(new Uint8Array([1]), 'audio/wav', 1000)).rejects.toThrow('格式')
  })

  it('rejects a segment over three minutes and an interview over ten minutes', async () => {
    await expect(createAudioAttachment(new Uint8Array([1]), 'audio/webm', MAX_AUDIO_SEGMENT_MS + 1)).rejects.toThrow('3 分钟')
    await expect(createAudioAttachment(new Uint8Array([1]), 'audio/mp4', 1000, { durationMs: MAX_AUDIO_TOTAL_MS })).rejects.toThrow('10 分钟')
  })

  it('rejects oversized audio before it can enter the package', async () => {
    await expect(createAudioAttachment(new Uint8Array(MAX_AUDIO_SEGMENT_BYTES + 1), 'audio/webm', 1000)).rejects.toThrow('体积')
    await expect(createAudioAttachment(new Uint8Array([1]), 'audio/webm', 1000, { bytes: MAX_AUDIO_TOTAL_BYTES })).rejects.toThrow('合计体积')
  })
})
