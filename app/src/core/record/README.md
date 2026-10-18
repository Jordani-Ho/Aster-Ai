# record · 病历格式

`types.ts` 是病历（Encounter）、问诊包（ConsultPackage）、作业（Homework）的类型定义，与 `docs/schemas/encounter.md` 逐字一致。

- 修改属于 B 类，须同时改文档和本文件。
- 签名病历是 kind 2730 的 Nostr 事件，见文档第 2 节。
- 三条硬规则（签字前不得残留 `ai_draft`、`intake` 只来自学生、学生端只认有效签名）见文档第 3 节。

## M1-11 签字与交还

- `sign.ts`：`signEncounter(encounter, privateKey)` 生成 kind 2730 签名事件；`pendingDraftFields` 检查四诊/判断/处理/作业/结果里是否还有 `ai_draft`（结果里的 `ai_draft` 同样算未确认），有一条就拒绝签字；`intakeSourceViolations` 检查 `intake` 每一项来源：其他 kind 只许 `student` 或 `unknown`，面诊（`kind: 'in_person'`）额外允许来源 `teacher` 且 `note` 为 `in_person`，否则拒绝签字。`verifySignedEncounter` 校验签名、内容哈希、老师身份与 `p` 标签，先重算事件 id 避免 nostr-tools 的已验证缓存（E-004），并做纵深防御：签名有效但带 `ai_draft` 或 `intake` 来源不符合规则的病历也拒绝。`deidentifiedCaseBook` 只保留判断/处理/结果与性别、年龄段；`modificationLog` 只逐字段保留 `judgment` 与 `plan` 的 AI 原文与老师定稿（`fourExams` 常转述学生原话，不记录）；`nextVersion` 保持 `id` 不变，只把 `version + 1`，`supersedes` 指向上一版的签名事件 id。
- `handover.ts`：交还顺序是**先发送、成功后才销毁**。`completeSigning` 先把签名事件（连同重发所需的草稿与附件 id）暂存到 `pending-handover`，调用 `send('record.signed', event)`；失败时抛 `UndeliveredError`（“未送达，可重发”），问诊包、附件、日志、医案、索引都不动，界面据此提示重发；成功后才删除问诊包与附件（只记时间和病历 id 的本地日志）、写去标识医案与修改记录、写老师端索引，最后删掉暂存。`retryHandover` 按签名事件 id 重发暂存内容。M1-05 未合并时由调用方传入发送桩。
- 老师端 `signed-encounters` 只存索引 `{ eventId, encounterId, version, student, createdAt }`，不留病历内容（eventId 供康币扣费的 recordHash 与改方的 previousOf 使用）；学生端才保留旧版病历。
- 签名模块及其依赖不导入 `core/llm`（测试检查），签字路径里不存在模型调用。
- 老师端本地集合：`consult-package`、`attachments`、`signed-encounters`、`case-book`、`record-log`、`pending-handover`，登记在 `app/src/core/store/README.md`。
- 验收测试：`app/src/core/record/record.test.ts`（12 项，合成身份与合成病历）。界面 `app/src/SignEncounterPage.tsx` 用整张卡片及来源标记展示草稿；真人按“签字发出”时由纯函数 acceptDraftForSigning 统一确认 ai_draft（含作业与结果），然后才签字；改稿阶段不确认来源，交还失败可重发；截图 `docs/screenshots/sign-encounter-375.png`。

## M1-12 面诊记录

- `in-person.ts`：老师端新建 `kind: 'in_person'` 病历（`startInPersonEncounter`）；`recordIntakeField` 由老师代录 intake，非空项来源为 `teacher`、`note` 为 `in_person`，每次录入都过 `core/redflags` 的本地急症红线，命中只提示“请立即安排就医”不阻断（老师在现场判断）。`addInPersonPhoto` 接收 M1-09 `photo.ts` 已处理的 `AttachmentRef`，最多 4 张。
- 面诊是 `intake` 来源硬规则的唯一例外，且只认 `kind === 'in_person'`：`signEncounter` 与 `verifySignedEncounter` 都按 kind 放行，同样内容改成 `remote_async` 后签不了、学生端也拒收。学生端展示用 `intakeDisplayLabel` 在主诉旁标“老师代录”。
- 起草复用 M1-10：`inPersonConsultPackage` 把面诊病历转成 `ConsultPackage` 交给 `draftEncounter`；审改签字与交还复用 M1-11：`signAndHandoverInPerson` 调用 `signEncounter` + `completeSigning`，成功后删除 `in-person-draft`。发送失败抛 `InPersonUndeliveredError`（带签名事件 id），`retryInPersonHandover` 重发同一条事件，送达后才销毁资料、写索引与医案。照片字节存 `attachments` 集合，交还时随问诊资料一并删除。
- 老师端界面 `app/src/InPersonPage.tsx`：选学生（本机已有签字索引或已收到的问诊）→ 一个输入框逐句代录、固定追问可跳过 → 当面拍照 → 复用 `SignEncounterPage` 改稿与一键签字。截图 `docs/screenshots/in-person-375.png`。
- 验收测试：`app/src/core/record/in-person.test.ts`（5 项，合成身份与合成病历）。
- 本机集合：`in-person-draft`（进行中的面诊草稿，含代录原文与附件索引，签字交还成功后删除）、`record-outbox`（中继设置接好前的待发签名病历）。

M1-20：面诊页面将 record.signed 接入共享 transport，发送成功后才删除面诊草稿；未连接或发送失败保留原文，可在当前会话重发。面诊照片由 core/inbox.sendInPersonRecord 在签名病历后逐张加密交还；每张带同一签名病历，学生验签、核对本人收件人和原引用的 SHA-256/长度后落盘。全部消息被中继接受后才清理老师原件，失败保留同一签名和字节供重发。

## M1-23b 视频交还

Homework.video 是人工附加的可选引用，签字与学生验签均核对老师、学生、作业和 original 角色。
签字流程仍不引用 core/llm。去标识医案和改稿记录必须剔除 video；成功发送后 handover 删除
本次所有暂存视频字节、随机索引、草稿与暂存清单，失败则保留同一签名重发。
回看时由学生明确重新授权原片与当天练习，老师不依赖永久留片；详情见 core/practice-video/README.md。
