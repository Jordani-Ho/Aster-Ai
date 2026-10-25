# 学生采集（M1-09）

V2-03：问诊页不再使用 `processPhoto/addPhoto` 收集原图附件；共用 `TongueCapture`，仅把严格抽象记录放入 `session.tongues` 和 `Encounter.intake.tongues`。草稿恢复、发送与老师收件沿用同一结构，最多四份。旧附件底层协议未整库重写，不是新版页面的照片入口。

学生在手机上把不舒服说清楚；智能体按老师模板追问缺的项，整理好后由学生点“确认发送”。确认前可由本人的模型账户整理必要原话；确认后才把问诊包发给老师。

## 模块

- `photo.ts`：手机拍照处理。长边缩到 ≤1600 像素、JPEG 质量 0.8 重新编码；每张 ≤500 KB（超限按 0.8 → 0.6 → 0.4 逐级降质量重编码），最多 4 张。生成 `AttachmentRef`（sha256、bytes）。只用浏览器自带能力（`createImageBitmap` + canvas），不新增依赖；测试注入 `PhotoCodec` 替身，不需要浏览器。V2 起不再逐段剥离 EXIF（canvas 重编码本身不保留原图元数据；继续逐段解析属多余层，已删）。V2-20 起返回值另带 `source`（解码出的原图尺寸）与 `image`（实际写出的尺寸）；舌象路径用 `source` 判断离得够不够近。
- `followup.ts`：追问与整理。模型（经 `core/llm` 的用户模型客户端）只做两件事：从学生**原话**里逐字摘取片段归入 `intake` 字段、指出还缺哪些 focus。所有片段必须能在学生原话里找到（逐字子串），否则丢弃——模型改写、编造或夹带“把来源写成 teacher”都不会生效。断网或模型失败时退回固定问句（`domain/tcm/templates/default-questions.json`），流程不中断。每轮最多问 2 项，最多 3 轮，之后直接进确认页。
- `session.ts`：采集状态机。只记录学生原话、整理结果与追问；V2-18 起不判断急症或心理状况，也不产生任何标记。确认页展示整理结果（学生可改任何一项，来源仍是 `student`）；未在确认页看过（`markReviewed`）不能进问诊包。`confirmAndSend` 只由学生点“确认发送”触发，先调用注入的 `send(pkg)`，成功后保存本人副本并删除草稿。确认发送的代码路径不调用模型。V2-32：确认页还可加 `posture`（学生在家拍的体态骨架，见 `core/posture/README.md`），草稿里只有关键点；发送时 `buildConsultPackage` 清洗后放进 `ConsultPackage.postures`，不进附件通道、不带图片字节。
- `profile` / 历史病历：`buildConsultPackage` 的 `profile` 从本机常驻档案（`profile` 集合）读；历史病历从 `student-records` 集合读，默认勾选同一位老师的近 3 次（`defaultHistorySelection`），学生取消后不进包。V2-06：确认发送时把 `heavenStampOf(await heavenNow(store))` 作为 `options.heaven` 传进来，写进问诊包与病历（家人问诊用家人分片的城市）；`heaven` 可选，缺了不影响发送。

## 界面

`app/src/ConsultPage.tsx`（V2-17 按 10a–10d 重画）：老师公钥 → 说一说（输入法语音输入）→ 再问一句（可跳过）→ 看一眼问诊卡片再发出（字段、舌象、旧病历、本机档案）→ 确认发送。V2-32 起卡片页与舌象并列多一块“这次的体态（可空）”（`app/src/PostureAtHome.tsx`），拍正面/侧面各一张或一段 ≤15 秒走路视频。手机竖屏 375px 可用。问诊三步顶端都渲染 `app/src/CareReminder.tsx` 的常驻提醒；文案只在那个组件里，不能关、不拦截发送，任何情况下都不弹提醒、不显示电话号码。

## 发送边界

M1-05 未合并前，`ConsultPage` 传入的发送替身把问诊包加密写入本机 `intake-outbox`，不会外发；界面明确说“中继接通后才会交给老师”。模型客户端由 `llm` 参数注入：M1-21 在 App 注入与老师工作台相同的用户模型客户端；无可用模型时仍退回固定问句。

## 本地集合

`intake-draft`、`intake-sent`、`intake-outbox`、`intake-attachments`、`profile`、`student-records`，登记在 `app/src/core/store/README.md`。

## 验证

`app/src/core/intake/intake.test.ts` 覆盖 7 条验收：确认前不调用 `send`、无额外网络请求（模型请求由替身记录）；断网退回固定问句并走到确认页；急症样文字不阻断、不标记、发送仍可用；合成 JPEG 重编码后为 JPEG、≤500 KB、长边 ≤1600、最多 4 张；跳过“二问汗”对应内容保持 `unknown`、不用模型编造；模型夹带指令无效且内容须学生确认；默认附带同一位老师近 3 次历史病历、取消后不含。第 8 条为补充：确认页可改字段、来源仍为学生，整理器只接受学生原话。另加审核补充：确认页改写的文字不产生任何标记；附件逐个核对 id、sha256、bytes 与确认页一致，不一致就拒绝。

M1-21：采集整理会把必要原话发到本人所选模型；确认发送指把问诊包交给老师，不能再声称确认前所有文字只在本机。V2-18 起采集流程不做任何急症/心理判断，只在问诊页顶端常驻一句就医提醒。
