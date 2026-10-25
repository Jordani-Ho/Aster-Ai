# V2-32 体态：学生在家也能拍

- 状态：已实现，PR #69 待审核（DeepSeek）
- 依据：V2-30 卡第 1 条（手机输入：学生或家人账户自己拍）；V2-30 合并时只做了老师端采集，学生端只读
- 原则：沿用 V2-30 的识别、指标和骨架图，不另做一套；照片和视频识别完当场清掉。

## 范围

1. **学生端采集**：问诊“看一眼，再发出”卡片页里，和舌象并列加一块“这次的体态（可选）”：拍正面、侧面各一张，或一段 ≤15 秒的走路视频。在学生手机上识别成关键点，照片和视频当场清掉。
2. **随问诊包发给老师**：问诊包带上 `postures`（只有关键点、视角、时间、学生自己写的感觉；不带图片），老师在远程审核页看到骨架图和他自己定的指标值。指标在**老师端**按老师的公式算，学生端不显示数值、不下结论。
3. **记录页**：学生在“记录”里能看到自己历次体态的骨架图（V2-30 已有只读展示，接上即可）。
4. **家人账户**：代管的家人同样能拍，归在这位家人名下。

## 验收用例

1. 合成正面图：学生端识别出关键点，问诊包里有 `postures`，没有任何图片字节；学生端应用里查不到照片。
2. 老师远程审核页显示骨架图和老师自定义的指标值。
3. 不拍体态也能正常发出问诊（可选项）。
4. 家人账户拍的，老师端显示在这位家人名下。
5. iPhone 15 Pro 与华为两种宽度截图；只用合成图；CI 三项全过。

## 完成记录（2026-10-24）

- PR：https://github.com/Jordani-Ho/Aster-Ai/pull/69（分支 `task/V2-32-posture-at-home`，未合并）。
- 学生端采集：`ConsultPage` 卡片页与舌象并列新增“这次的体态（可空）”（`app/src/PostureAtHome.tsx`）：拍正面、拍侧面各一张，或一段 ≤15 秒走路视频；每段可写一句感觉。识别管线抽成 `core/posture/capture.ts` 的 `analyzePostureFile`（照片走 V2-20 `processPhoto`、视频取中间帧、识别完字节清零），老师端 `PostureTool` 与学生端共用同一份，没有另做一套。
- 只传骨架：`IntakeSession.posture?: PostureRecord`（草稿进 `intake-draft`，无图片字节）；`buildConsultPackage` 用 `sanitizeStudentPostures` 再清洗一次后放进 `ConsultPackage.postures`。学生端不算指标（`metrics/values` 为空）。
- 问诊包：`ConsultPackage.postures?: PostureRecord[]`，经 `consult.package` 信封传输；`StoredConsult.postures` 保存；老包没有该字段照常收。接收端只接受 `capturedBy:'student'`、`phone` 来源、最多两段（视频单独一段）、无老师标注/图片/指标数值的记录，格式不对只丢体态、问诊照收。
- 老师端：`RemoteReview` 用老师 `settings/posture-metrics` 的公式对骨架算指标，核对页正文新增 `StudentPostureReview`（骨架 + 指标值）；签字时 `applyPostureMetrics` 生成指标快照写进 `Encounter.postures`。`signEncounter`/`verifySignedEncounter` 允许远程携带学生自己拍的记录、拒绝老师拍的或带标注的记录。
- 学生记录页：`StudentRecordsPage` 只显示骨架与“学生在家拍”，`PostureSummary showValues={false}` 不显示数值、不下结论。
- 家人：用家人自己的身份/分片拍，问诊包带代管证明；老师端按发件人显示“妈妈（我代管）”，签字后病历回到这位家人的记录页。
- 测试：app **67 文件 / 524 测试**（新增 `athome.test.ts` 7 项 + intake/inbox 新增 8 项）；`e2e/v232.browser.mjs` 全 PASS（验收 1–5 + 可选项）；CI 新增 V2-32 浏览器步骤。
- 截图：`docs/screenshots/v232-posture-student-iphone15pro-393.png`、`v232-posture-student-huawei-412.png`、`v232-posture-student-huawei-448.png`、`v232-posture-teacher-393.png`（合成图；CI 用 Chromium 视口模拟宽度，未上真机 WebKit）。
- 风险：真机识别质量仍需人工确认（CI 业务验收用检测器桩，模型资产 smoke 仍由 V2-30 覆盖）；学生端不显示数值，若以后要让学生看趋势需另立卡；不做数据迁移。
