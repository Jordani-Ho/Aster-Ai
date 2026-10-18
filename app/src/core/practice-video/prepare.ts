import { encryptVideo, MAX_VIDEO_BYTES, uploadVideo, writeVideoCipher, type VideoContext } from './index'
import type { Identity } from '../identity'
import type { LocalStore } from '../store'
import type { Conversion as MediaConversion } from 'mediabunny'

export async function prepareVideo(file: File) {
  // BlobSource reads incrementally. Do not copy a large camera file into JS before conversion.
  const { Input, BlobSource, ALL_FORMATS, Output, BufferTarget, Mp4OutputFormat, Conversion } = await import('mediabunny')
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw Error('无法读取这段视频，请用系统相机重新录制')
    const duration = await input.computeDuration()
    if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw Error('单段不超过 3 分钟')
    if ('VideoEncoder' in globalThis && 'AudioEncoder' in globalThis) {
      let conversion: MediaConversion | undefined
      try {
        const scale = Math.min(1, 1280 / Math.max(track.displayWidth, track.displayHeight), 720 / Math.min(track.displayWidth, track.displayHeight))
        const target = new BufferTarget(), output = new Output({ target, format: new Mp4OutputFormat() })
        conversion = await Conversion.init({ input, output, tracks: 'primary', copy: false, tags: {}, showWarnings: false,
          video: { codec: 'avc', width: Math.max(2, Math.floor(track.displayWidth * scale / 2) * 2), height: Math.max(2, Math.floor(track.displayHeight * scale / 2) * 2), bitrate: 1500000, allowTransformationMetadata: false },
          audio: { codec: 'aac', bitrate: 128000 },
        })
        // Actual encoder availability matters; never silently discard narration.
        if (!conversion.isValid || conversion.discardedTracks.length) throw Error('encoder unavailable')
        await conversion.execute()
        if (!target.buffer || target.buffer.byteLength > MAX_VIDEO_BYTES) throw Error('conversion too large')
        return { bytes: new Uint8Array(target.buffer), mime: 'video/mp4', duration, compressed: true }
      } catch { await conversion?.cancel().catch(() => {}) }
    }
    if (file.size > MAX_VIDEO_BYTES) throw Error('请剪短一点')
    const mime = file.type || (file.name.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4')
    if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(mime)) throw Error('请用系统相机录制，或选择 MP4 视频')
    return { bytes: new Uint8Array(await file.arrayBuffer()), mime, duration, compressed: false }
  } finally { input.dispose() }
}

export async function prepareAndUpload(file: File, context: VideoContext, store: LocalStore, identity: Identity, base: string) {
  const media = await prepareVideo(file)
  try {
    const encrypted = await encryptVideo(media.bytes, media.mime, media.duration, context)
    await uploadVideo(base, identity, encrypted.ref, encrypted.bytes)
    await writeVideoCipher(store, encrypted.ref.sha256, encrypted.bytes)
    return encrypted.ref
  } finally { media.bytes.fill(0) }
}

export function mediaBase() { return new URL('/media', window.location.origin).href }
