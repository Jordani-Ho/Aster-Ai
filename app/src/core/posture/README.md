# posture 路 体态工具（V2-30）

> 工具只管数据和规则，不自己判断（`docs/智能体架构.md` 第八节）。指标由老师定；我们只给四条示例，不内置正常范围或诊断。

## 模块

- `freemocap.ts`：只读 FreeMoCap 导出的文件（**不引入其 AGPL 代码**），转成统一关键点。
- `detector.ts`：浏览器内单人骨骼识别（MediaPipe Pose Landmarker，模型与 wasm 都从本站加载）。
- `index.ts`：老师指标读写（`settings/posture-metrics`）、体态草稿（`posture-drafts`）、从签字病历读体态、动作转作业。
- 类型与纯函数在 `domain/tcm/posture.ts`：公式引擎、指标计算、拖动改点重算、前后对比、长期趋势、失衡次数。

## 坐标口径

- 统一为 **0–1 归一化二维坐标**，原点左上、y 向下；每个点可带 `visibility`（0–1）与可选 `z`。
- 手机/摄像头：MediaPipe 直接给归一化坐标；照片按 V2-20 `processPhoto` 先规范化（JPEG、去 EXIF），视频取中间一帧，≤15 秒。
- FreeMoCap：坐标是右手系 XYZ、**毫米**，groundplane 对齐后 Z 向上。导入时投到二维再归一化：
  - 正视：水平 = X，竖直 = Z；侧视：水平 = Y，竖直 = Z；
  - 归一化到 min/max（整段身体），竖直翻转成屏幕 y（越高 y 越小）；
  - 原始 z 存在点的 `z` 里，**不参与公式**。
- 公式只做二维运算，因此 2D 与 3D 来源用同一套指标。

## 指标（老师模板里可改/删/加）

白名单运算（函数名写死）：

| 函数 | 含义 | 返回 |
| :-- | :-- | :-- |
| `heightDiff(a, b)` | 两点高低差 | 归一化差 ×100 |
| `distance(a, b)` | 两点距离 | 归一化 ×100 |
| `angle(a, b, c)` | 以 b 为顶点的三点夹角 | 度 |
| `symmetry(a, b)` | 两点到身体中线距离之差 | ×100 |
| `midlineOffset(a)` | 点到身体中线的水平距离 | ×100 |

身体中线 = 两肩中点与两髋中点的平均 x。默认四条示例见 `domain/tcm/tongue-features` 旁的 `domain/tcm/posture-metrics.json`：
两肩高低差、骨盆倾斜（左右髋高低差）、头前伸（头-肩-髋夹角）、脊柱偏离中线（`midlineOffset(nose)`）。
单位由老师填，我们不做换算。写错时 `validatePostureFormula` 返回具体位置与原因（不认识的运算 / 关键点 / 少括号 / 多字符）。

**看不清就不算**：`visibility < 0.5` 的点算“看不清”，公式用到它时该指标为 `unavailable`，界面显示“这次算不出”，不编数；拖动改过的点用改后坐标重算。

## 输入校验

- 照片/视频格式与大小沿用 V2-20 的规范化与分档；视频 > 15 秒、> 30 MB、格式不支持都明确说明。
- 画面里没有人 / 不止一个人：明确提示，不猜（detector 返回人数，界面各自一句话）。
- FreeMoCap：格式不对、缺关键点（鼻、两肩、两髋、两膝、两踝）、帧数为零都拒绝并说明。
- 照片/视频识别完当场清零，只留关键点与线条骨架图；不进附件通道、不写本机。

## FreeMoCap 导出格式（结论）

调研基于 FreeMoCap 官方源码/文档（2026-10）：稳定版 **1.8.2**（PyPI），最新 tag **v2.0.0-alpha.25**。记录目录仍是 legacy 布局
`~/freemocap_data/recording_sessions/session_.../recording_.../output_data/`：

- **首选导入**：`output_data/freemocap_data_by_frame.csv`（2.0）或 `{recording}_by_frame.csv`（1.8.2）——逗号分隔、有表头、长表（行 = 帧 × 关键点）：
  - 2.0：`frame,keypoint,x,y,z,model,trajectory,reprojection_error`
  - 1.8.2：`frame,timestamp,timestamp_by_camera,model,keypoint,x,y,z,reprojection_error`
  - 我们取中间帧；`model` 含 body/face/hand 多组时只保留 body（`mediapipe.body` 等）。
- **最稳备选**：`output_data/mediapipe_body_3d_xyz.npy`，`(frames, 33, 3)` float，毫米；也兼容 `(frames, 99)` 展平。
- **不支持/不按文件名猜**：1.8.2 的 `mediapipe_body_3d_xyz.csv` 是宽表（99 列、无 frame 列），2.0 同名文件却是长表——同名不同格式，按内容判断而不只看文件名；目前只支持上面的长表 CSV 与 npy。
- 关键点顺序：MediaPipe body 33（与本站命名一致）；2.0 默认 RTMPose-WholeBody 133，body 23 能映射的会映射，缺的必需点会拒绝。
- 陷阱（README 与 PR 已写）：2.0 alpha 骨架尺度可能偏差约 10%（mm 绝对值不可全信）；`tracker_schema.json` 在 2.0 硬编码为 RTMPose schema，不可当权威；2D 数据只有 `(numCams,numFrames,numPoints,2)` 的 npy，没有每相机文件。

## 资产与许可

- `app/public/posture/pose_landmarker_lite.task`：MediaPipe Pose Landmarker（lite float16 v1），Apache-2.0，随部署自托管（来源与版本见该目录 README），页面运行时不请求国外 CDN。
- `@mediapipe/tasks-vision@1.1.1`（Apache-2.0，版本写死）；wasm 在构建/启动时由 `vite.config.ts` 的 `posture-assets` 插件从 `node_modules` 复制到 `app/public/posture/wasm/`（不重复入库）。
- e2e：`e2e/posture.browser.mjs` 用可注入检测器桩跑业务验收，另有一条 `scene=real` 的本地资源 smoke（断言只请求本站）。

## 隐私

照片/视频只在识别时存在于内存，识别完当场清零；记录里只有关键点坐标、老师标注（`source: 'teacher'`）和指标值；骨架是线条图，认不出是谁。体态记录只随面诊签字保存（`Encounter.postures`），远程问诊包不带。
