// V2-30 / V2-32 共用的识别管线：照片走 V2-20 processPhoto 规范化，视频取中间帧；
// 只返回关键点，照片/视频字节在返回前清零、不写本机。老师端与学生端都用这一份。
import { processPhoto } from '../intake/photo'
import type { PostureFrame } from '../../../../domain/tcm/posture'
import type { PoseDetector } from './detector'

export const VIDEO_MAX_BYTES = 30 * 1024 * 1024
export const VIDEO_MAX_SECONDS = 15

export interface AnalyzePostureOptions {
  /** 正面 / 侧面；视频固定按 video 记。 */
  view: 'front' | 'side'
  now?: () => Date
}

async function detectFrame(engine: PoseDetector, source: HTMLImageElement | HTMLVideoElement | ImageBitmap | HTMLCanvasElement, frame: Omit<PostureFrame, 'points'>): Promise<PostureFrame> {
  const result = await engine.detect(source)
  if (result.people === 0) throw new Error('画面里没找到人：请让整个人进画面再拍。')
  if (result.people > 1) throw new Error('画面里不止一个人：请只让一位学生进画面。')
  return { ...frame, points: result.points! }
}

export async function analyzePostureFile(file: File, engine: PoseDetector, options: AnalyzePostureOptions): Promise<PostureFrame> {
  const at = (options.now ?? (() => new Date()))().toISOString()
  if (file.type.startsWith('video/')) {
    if (file.size > VIDEO_MAX_BYTES) throw new Error('视频超过 30 MB，请拍短一点或只拍一张照片。')
    if (!/^video\/(mp4|webm|quicktime)$/.test(file.type)) throw new Error('视频格式不支持：请用手机相机拍的 MP4/WebM，或改拍照片。')
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.muted = true; video.playsInline = true; video.src = url
    try {
      await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error('视频没能打开：请换一段手机相机拍的短视频。')) })
      if (video.duration > VIDEO_MAX_SECONDS) throw new Error(`视频 ${Math.round(video.duration)} 秒，超过 15 秒；请拍短一点，只留需要看的那一段。`)
      video.currentTime = Math.max(0, video.duration / 2)
      await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error('视频没能读到画面：请换一段短视频。')) })
      return await detectFrame(engine, video, { source: 'phone', view: 'video', at, width: video.videoWidth, height: video.videoHeight })
    } finally {
      URL.revokeObjectURL(url); video.removeAttribute('src'); video.load()
    }
  }
  if (!file.type.startsWith('image/')) throw new Error('只支持照片（JPEG/PNG/WebP）或 15 秒内的短视频。')
  let bytes: Uint8Array | null = null
  try {
    const photo = await processPhoto({ bytes: new Uint8Array(await file.arrayBuffer()), type: file.type })
    bytes = photo.data
    const bitmap = await createImageBitmap(new Blob([photo.data as unknown as BlobPart], { type: 'image/jpeg' }))
    try {
      return await detectFrame(engine, bitmap, { source: 'phone', view: options.view, at, width: bitmap.width, height: bitmap.height })
    } finally { bitmap.close() }
  } finally { if (bytes) bytes.fill(0) }
}
