# record · 病历格式

`types.ts` 是病历（Encounter）、问诊包（ConsultPackage）、作业（Homework）的类型定义，与 `docs/schemas/encounter.md` 逐字一致。

- 修改属于 B 类，须同时改文档和本文件。
- 签名病历是 kind 2730 的 Nostr 事件，见文档第 2 节。
- 三条硬规则（签字前不得残留 `ai_draft`、`intake` 只来自学生、学生端只认有效签名）见文档第 3 节。

## M1-11 签字与交还

- `sign.ts`：`signEncounter(encounter, privateKey)` 生成 kind 2730 签名事件；`pendingDraftFields` 检查四诊/判断/处理/作业里是否还有 `ai_draft`，有一条就拒绝签字。`verifySignedEncounter` 校验签名、内容哈希、老师身份与 `p` 标签；先重算事件 id，避免 nostr-tools 的已验证缓存（E-004）。`deidentifiedCaseBook` 只保留判断/处理/结果与性别、年龄段；`modificationLog` 逐字段保留 AI 原文与老师定稿；`nextVersion` 生成 version+1、`supersedes` 指向旧签名事件。
- `handover.ts`：`completeSigning` 依次保存签名病历、删除问诊包与附件（只记时间和病历 id 的本地日志）、保存去标识医案与修改记录、调用 `send('record.signed', event)` 交还学生；M1-05 未合并时由调用方传入发送桩。
- 签名模块及其依赖不导入 `core/llm`（测试检查），签字路径里不存在模型调用。
- 老师端本地集合：`consult-package`、`attachments`、`signed-encounters`、`case-book`、`record-log`，登记在 `app/src/core/store/README.md`。
- 验收测试：`app/src/core/record/record.test.ts`（9 项，合成身份与合成病历）。界面 `app/src/SignEncounterPage.tsx` 用颜色区分来源，AI 草稿逐项“采用/修改”，未确认完不能签字；截图 `docs/screenshots/sign-encounter-375.png`。
