import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { encryptVideo, decryptVideo, validateVideoRef, downloadVideo, MAX_VIDEO_BYTES } from './index'

const context = { student: 'a'.repeat(64), teacher: 'b'.repeat(64), homework: 'synthetic-homework', role: 'original' as const }
describe('practice video encryption boundary', () => {
  it('encrypts a synthetic 20MB MP4; changing one byte or its student binding fails', async () => {
    const plain = new Uint8Array(20 * 1024 * 1024)
    const sample = readFileSync(new URL('../../../../e2e/fixtures/practice-60s.mp4', import.meta.url))
    plain.set(sample)
    new DataView(plain.buffer).setUint32(sample.length, plain.length - sample.length)
    plain.set(new TextEncoder().encode('free'), sample.length + 4)
    const { Input, BufferSource, ALL_FORMATS } = await import('mediabunny')
    const parsed = new Input({ source: new BufferSource(plain), formats: ALL_FORMATS })
    expect(await parsed.getPrimaryVideoTrack()).not.toBeNull()
    expect(await parsed.getPrimaryAudioTrack()).not.toBeNull()
    parsed.dispose()
    const first = await encryptVideo(plain, 'video/mp4', 60, context)
    const second = await encryptVideo(plain, 'video/mp4', 60, context)
    expect(first.ref.key).not.toBe(second.ref.key)
    expect(first.ref.iv).not.toBe(second.ref.iv)
    expect(first.bytes.slice(4, 8)).not.toEqual(plain.slice(4, 8))
    const encryptedInput = new Input({ source: new BufferSource(first.bytes), formats: ALL_FORMATS })
    await expect(encryptedInput.getPrimaryVideoTrack()).rejects.toThrow()
    encryptedInput.dispose()
    expect(Buffer.compare(await decryptVideo(first.bytes, first.ref, context), plain)).toBe(0)
    const bad = first.bytes.slice(); bad[9] ^= 1
    await expect(decryptVideo(bad, first.ref, context)).rejects.toThrow()
    await expect(decryptVideo(first.bytes, first.ref, { ...context, student: 'c'.repeat(64) })).rejects.toThrow()
    const forged = { ...first.ref, context: { ...context, student: 'c'.repeat(64) } }
    await expect(decryptVideo(first.bytes, forged, forged.context)).rejects.toThrow()
  })
  it('rejects oversized, too long or malformed descriptors before downloading', async () => {
    await expect(encryptVideo(new Uint8Array(32), 'video/mp4', 181, context)).rejects.toThrow('3 分钟')
    const value = await encryptVideo(new Uint8Array(32), 'video/mp4', 60, context)
    expect(() => validateVideoRef({ ...value.ref, bytes: MAX_VIDEO_BYTES + 17 }, context)).toThrow()
    expect(() => validateVideoRef({ ...value.ref, key: '00' }, context)).toThrow()
  })
  it('interrupted or oversized download is discarded; retry validates the whole file', async () => {
    const encrypted = await encryptVideo(new Uint8Array(64), 'video/mp4', 60, context)
    let calls = 0
    const fetcher = async () => {
      calls++
      if (calls === 1) return new Response(new ReadableStream({ start(c) { c.enqueue(encrypted.bytes.slice(0, 10)); c.error(Error('interrupted')) } }))
      return new Response(encrypted.bytes)
    }
    const { generateSecretKey, getPublicKey } = await import('nostr-tools/pure')
    const privateKey = generateSecretKey(), who = { privateKey, publicKey: getPublicKey(privateKey) }
    await expect(downloadVideo('https://app.example/media', who, encrypted.ref, context, fetcher)).rejects.toThrow()
    expect(await downloadVideo('https://app.example/media', who, encrypted.ref, context, fetcher)).toEqual(encrypted.bytes)
  })
})
