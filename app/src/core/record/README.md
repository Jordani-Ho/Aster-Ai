# record · 病历格式

`types.ts` 是病历（Encounter）、问诊包（ConsultPackage）、作业（Homework）的类型定义，与 `docs/schemas/encounter.md` 逐字一致。

- 修改属于 B 类，须同时改文档和本文件。
- 签名病历是 kind 2730 的 Nostr 事件，见文档第 2 节。
- 三条硬规则（签字前不得残留 `ai_draft`、`intake` 只来自学生、学生端只认有效签名）见文档第 3 节。

## M1-11 签字与交还

- `sign.ts`：`signEncounter(encounter, privateKey)` 生成 kind 2730 签名事件；`pendingDraftFields` 检查四诊/判断/处理/作业/结果里是否还有 `ai_draft`（结果里的 `ai_draft` 同样算未确认），有一条就拒绝签字；`studentIntakeSources` 检查 `intake` 每一项来源只能是 `student` 或 `unknown`，否则拒绝签字。`verifySignedEncounter` 校验签名、内容哈希、老师身份与 `p` 标签，先重算事件 id 避免 nostr-tools 的已验证缓存（E-004），并做纵深防御：签名有效但带 `ai_draft` 或 `intake` 来源不对的病历也拒绝。`deidentifiedCaseBook` 只保留判断/处理/结果与性别、年龄段；`modificationLog` 只逐字段保留 `judgment` 与 `plan` 的 AI 原文与老师定稿（`fourExams` 常转述学生原话，不记录）；`nextVersion` 保持 `id` 不变，只把 `version + 1`，`supersedes` 指向上一版的签名事件 id。
- `handover.ts`：交还顺序是**先发送、成功后才销毁**。`completeSigning` 先把签名事件（连同重发所需的草稿与附件 id）暂存到 `pending-handover`，调用 `send('record.signed', event)`；失败时抛 `UndeliveredError`（“未送达，可重发”），问诊包、附件、日志、医案、索引都不动，界面据此提示重发；成功后才删除问诊包与附件（只记时间和病历 id 的本地日志）、写去标识医案与修改记录、写老师端索引，最后删掉暂存。`retryHandover` 按签名事件 id 重发暂存内容。M1-05 未合并时由调用方传入发送桩。
- 老师端 `signed-encounters` 只存索引 `{ eventId, encounterId, version, student, createdAt }`，不留病历内容（eventId 供康币扣费的 recordHash 与改方的 previousOf 使用）；学生端才保留旧版病历。
- 签名模块及其依赖不导入 `core/llm`（测试检查），签字路径里不存在模型调用。
- 老师端本地集合：`consult-package`、`attachments`、`signed-encounters`、`case-book`、`record-log`、`pending-handover`，登记在 `app/src/core/store/README.md`。
- 验收测试：`app/src/core/record/record.test.ts`（12 项，合成身份与合成病历）。界面 `app/src/SignEncounterPage.tsx` 用颜色区分来源，AI 草稿逐项“采用/修改”，未确认完不能签字，交还失败时提示“未送达，可重发”；截图 `docs/screenshots/sign-encounter-375.png`。
