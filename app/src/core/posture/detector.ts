// V2-30：浏览器内的单人骨骼识别（MediaPipe Pose Landmarker，模型与 wasm 都从本站加载）。
// 只输出关键点坐标；照片/视频在调用方识别完当场清掉，不写本机。
import type { PostureFrame, PosturePoint, PosturePointName } from '../../../../domain/tcm/posture'
import { POSTURE_POINTS } from '../../../../domain/tcm/posture'

export interface DetectedPerson { points: PostureFrame['points'] }
export interface DetectResult {
  people: number
  points?: PostureFrame['points']
}
export interface PoseDetector {
  detect(source: HTMLImageElement | HTMLVideoElement | ImageBitmap | HTMLCanvasElement): Promise<DetectResult>
  close?(): void
}

export const POSTURE_ASSET_BASE = '/posture/'

export async function createBrowserDetector(base = POSTURE_ASSET_BASE): Promise<PoseDetector> {
  const vision = await import('@mediapipe/tasks-vision')
  const fileset = await vision.FilesetResolver.forVisionTasks(base + 'wasm')
  const landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: base + 'pose_landmarker_lite.task', delegate: 'CPU' },
    runningMode: 'IMAGE',
    numPoses: 2, // 多于一人就明确提示，不猜
  })
  return {
    async detect(source) {
      const result = landmarker.detect(source)
      const people = result.landmarks?.length ?? 0
      if (people !== 1) return { people }
      const points: PostureFrame['points'] = {}
      result.landmarks![0].forEach((landmark, index) => {
        const name = POSTURE_POINTS[index] as PosturePointName | undefined
        if (!name) return
        const point: PosturePoint = { x: landmark.x, y: landmark.y, visibility: landmark.visibility }
        points[name] = point
      })
      return { people, points }
    },
    close() { landmarker.close() },
  }
}

// 测试/验收可注入桩：浏览器里设 window.__postureDetector（只用于 e2e，不进产品逻辑）。
export async function resolveDetector(injected?: PoseDetector): Promise<PoseDetector> {
  if (injected) return injected
  const globalDetector = (globalThis as unknown as { __postureDetector?: PoseDetector }).__postureDetector
  if (globalDetector) return globalDetector
  return createBrowserDetector()
}
