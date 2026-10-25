# 体态识别资产（自托管）

本目录随部署一起提供，页面运行时不请求任何国外 CDN；CI 的 `e2e/posture.browser.mjs` 会断言网络请求只到本站。

## 模型

- `pose_landmarker_lite.task`：MediaPipe Pose Landmarker（lite，float16，v1），来自
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`
  （首次领取时下载一次，之后提交进仓库，版本固定）。
- 许可：Apache License 2.0，见 `LICENSE-Apache-2.0.txt`。
- 输出 33 个关键点（MediaPipe Pose 标准命名，`nose`、`left_shoulder`……），归一化到 0–1，y 轴向下；
  每个点带 `visibility`。

## WASM 运行时

- `@mediapipe/tasks-vision@1.1.1`（Apache-2.0，版本写死在 `app/package.json`）。
- `wasm/` 目录由 `app/vite.config.ts` 的 `posture-assets` 插件在构建/开发服务器启动时从
  `node_modules/@mediapipe/tasks-vision/wasm` 复制过来（不提交进仓库，避免 27MB 二进制重复入库）；
  部署镜像里 `npm ci` 后 `npm run build` 会自动生成。
- 页面通过 `FilesetResolver.forVisionTasks('/posture/wasm')` 加载，模型路径 `/posture/pose_landmarker_lite.task`。

## 口径

- 手机/摄像头输入：图片或视频取一帧，MediaPipe 只做人形关键点，不认人、不存原图。
- 归一化坐标：x、y 都在 0–1，原点左上，y 向下；指标公式只用这二维坐标。
- 3D（FreeMoCap）导入：投到二维后再归一化（正视 = 水平 X / 竖直 Z；侧视 = 水平 Y / 竖直 Z，
  Z 向上、地面 Z=0，单位为毫米），原始 z 随记录保存、不参与公式；详见
  `app/src/core/posture/README.md`。
