# 学生采集（M1-09）

学生在手机上把不舒服说清楚；智能体按老师模板追问缺的项，整理好后由学生点“确认发送”。确认前可由本人的模型账户整理必要原话；确认后才把问诊包发给老师。

## 模块

- `photo.ts`：手机拍照处理。长边缩到 ≤1600 像素、JPEG 质量 0.8 重新编码，再逐段剥掉 JPEG 的 APP1（EXIF/XMP，含 GPS）保证输出里没有位置信息；每张 ≤500 KB（超限按 0.8 → 0.6 → 0.4 逐级降质量重编码），最多 4 张。生成 `AttachmentRef`（sha256、bytes）。只用浏览器自带能力（`createImageBitmap` + canvas），不新增依赖；测试注入 `PhotoCodec` 替身，不需要浏览器。
- `followup.ts`：追问与整理。模型（经 `core/llm` 的用户模型客户端）只做两件事：从学生**原话**里逐字摘取片段归入 `intake` 字段、指出还缺哪些 focus。所有片段必须能在学生原话里找到（逐字子串），否则丢弃——模型改写、编造或夹带“把来源写成 teacher”都不会生效。断网或模型失败时退回固定问句（`domain/tcm/templates/default-questions.json`），流程不中断。每轮最多问 2 项，最多 3 轮，之后直接进确认页。
- `session.ts`：采集状态机。每说一句、每次追问回答都先过 `core/redflags` 的本地 `check`；命中就中断、不能发送，学生点“我已知晓”后可重新开始。确认页展示整理结果（学生可改任何一项，来源仍是 `student`）；未在确认页看过（`markReviewed`）不能进问诊包。`confirmAndSend` 只由学生点“确认发送”触发，先调用注入的 `send(pkg)`，成功后保存本人副本并删除草稿。确认发送的代码路径不调用模型。
- `profile` / 历史病历：`buildConsultPackage` 的 `profile` 从本机常驻档案（`profile` 集合）读；历史病历从 `student-records` 集合读，默认勾选同一位老师的近 3 次（`defaultHistorySelection`），学生取消后不进包。

## 界面

`app/src/IntakePage.tsx`：老师公钥 → 说话（输入法语音输入）→ 急症提示 → 追问/跳过 → 确认页（字段、照片、旧病历、本机档案）→ 确认发送。手机竖屏 375px 可用，截图 `docs/screenshots/intake-confirm-375.png`。

## 发送边界

M1-05 未合并前，`IntakePage` 传入的发送替身把问诊包加密写入本机 `intake-outbox`，不会外发；界面明确说“中继接通后才会交给老师”。模型客户端由 `llm` 参数注入：M1-21 在 App 注入与老师工作台相同的用户模型客户端；无可用模型时仍退回固定问句。

## 本地集合

`intake-draft`、`intake-sent`、`intake-outbox`、`intake-attachments`、`profile`、`student-records`，登记在 `app/src/core/store/README.md`。

## 验证

`app/src/core/intake/intake.test.ts` 覆盖 7 条验收：确认前不调用 `send`、无额外网络请求（模型请求由替身记录）；断网退回固定问句并走到确认页；急症中断且不能发送；带 GPS EXIF 的合成 JPEG 处理后无 EXIF、≤500 KB、长边 ≤1600、最多 4 张；跳过“二问汗”对应内容保持 `unknown`、不用模型编造；模型夹带指令无效且内容须学生确认；默认附带同一位老师近 3 次历史病历、取消后不含。第 8 条为补充：确认页可改字段、来源仍为学生，整理器只接受学生原话。另加两条审核补充：确认页改写的文字也要过急症红线（命中后不能发送、send 不会被调用），buildConsultPackage 发送前对 intake 全字段再查一遍；附件逐个核对 id、sha256、bytes 与确认页一致，不一致就拒绝。

M1-21：采集整理会把必要原话发到本人所选模型；确认发送指把问诊包交给老师，不能再声称确认前所有文字只在本机。急症判断仍先在本机执行。
