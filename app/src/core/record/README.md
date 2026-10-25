# record · 病历格式

`types.ts` 是病历（Encounter）、问诊包（ConsultPackage）、作业（Homework）的类型定义，与 `docs/schemas/encounter.md` 逐字一致。

- 修改属于 B 类，须同时改文档和本文件。
- 签名病历是 kind 2730 的 Nostr 事件，见文档第 2 节。
- 三条硬规则（签字前不得残留 `ai_draft`、`intake` 只来自学生、学生端只认有效签名）见文档第 3 节。
- V2-06（B 类，已同步 `docs/schemas/encounter.md`）：`Encounter` 新增可选 `heaven: HeavenStamp`（`{shichen,jieqi,city}`，见 `core/heaven/stamp.ts`）。学生确认发送时取一次放进问诊包与病历，老师签字原样沿用、不重新取；面诊在老师开始面诊时取一次。没有 `heaven` 的旧病历照常验签打开，只是起草页不显示那一行；不参与签字硬规则、不做数据迁移。

## M1-11 签字与交还

- `sign.ts`：`signEncounter(encounter, privateKey)` 生成 kind 2730 签名事件；`pendingDraftFields` 检查四诊/判断/处理/作业/结果里是否还有 `ai_draft`（结果里的 `ai_draft` 同样算未确认），有一条就拒绝签字；`intakeSourceViolations` 检查 `intake` 每一项来源：其他 kind 只许 `student` 或 `unknown`，面诊（`kind: 'in_person'`）额外允许来源 `teacher` 且 `note` 为 `in_person`，否则拒绝签字。`verifySignedEncounter` 校验签名、内容哈希、老师身份与 `p` 标签，先重算事件 id 避免 nostr-tools 的已验证缓存（E-004），并做纵深防御：签名有效但带 `ai_draft` 或 `intake` 来源不符合规则的病历也拒绝。`modificationLog` 只逐字段保留 `judgment` 与 `plan` 的 AI 原文与老师定稿（`fourExams` 常转述学生原话，不记录）；`nextVersion` 保持 `id` 不变，只把 `version + 1`，`supersedes` 指向上一版的签名事件 id。
- V2 起删除了 `handover.ts`：签字后只发送，不再暂存待发、不销毁问诊包/照片、不写日志或去标识医案；记录删除由 V2-05 的保留期限统一处理。
- 老师端完整签名病历（V2-05 第 0 步）：签字发送成功后把整份签名事件存进 `teacher-records`（见 `core/records/README.md`），老师端不再只留索引、也不再写 `case-book`/`signed-encounters`；学生索引、起草时的医案检索、改方的 `previousOf`、康币扣费的 `recordHash` 都从这一个集合读，`recordHash` 就是签名事件 id。
- 签名模块及其依赖不导入 `core/llm`（测试检查），签字路径里不存在模型调用。
- 老师端本地集合：`teacher-records`（完整医案）、`teacher-students`（认得的学生的公钥名单）、`consult-package`、`attachments`、`in-person-draft`、`teacher-fingerprint`（改稿习惯摘要），登记在 `app/src/core/store/README.md`。
- 验收测试：`app/src/core/record/record.test.ts`（12 项，合成身份与合成病历）。界面 `app/src/SignReview.tsx` 把病历拆成判断/方子/作业/医嘱四块（四诊有草稿时多一块“四诊”），草稿是虚线黄框，老师逐块“改一改/就这样”；全部确认后“签字发出”才可点，再由纯函数 acceptDraftForSigning 统一确认 ai_draft（含作业与结果）后签字。`review-model.ts` 的纯逻辑（分块/逐块确认/改方差异）有单测。改稿阶段不确认来源，交还失败可重发；截图 `docs/screenshots/phone-teacher-review.png`。

## M1-12 面诊记录

- `in-person.ts`：老师端新建 `kind: 'in_person'` 病历（`startInPersonEncounter`）；`recordIntakeField` 由老师代录 intake，非空项来源为 `teacher`、`note` 为 `in_person`，只记录老师写的内容（V2-18 起不做急症判断）。`addInPersonPhoto` 接收 M1-09 `photo.ts` 已处理的 `AttachmentRef`，最多 4 张。
- V2-24：`in-person-herbs.ts` 在面诊交还前尝试处理本机库存；老师选择“不备药”时完全跳过，库外药不扣，缺货整方不扣，剂量无法处理的库内药跳过并在交还后提示。库存问题不拦签字，发送失败仍冲回已写流水；验收在 `in-person-herbs.test.ts`。
- 面诊是 `intake` 来源硬规则的唯一例外，且只认 `kind === 'in_person'`：`signEncounter` 与 `verifySignedEncounter` 都按 kind 放行，同样内容改成 `remote_async` 后签不了、学生端也拒收。学生端展示用 `intakeDisplayLabel` 在主诉旁标“老师代录”。
- 起草复用 M1-10：`inPersonConsultPackage` 把面诊病历转成 `ConsultPackage` 交给 `draftEncounter`（医案检索的案例来自 `teacher-records`）；审改签字与交还复用 M1-11：`signAndHandoverInPerson` 调用 `signEncounter` 后发送，发送成功后把完整签名病历存进 `teacher-records` 并更新改稿习惯摘要；发送失败资料原样保留，老师可在当前会话重发。照片字节存 `attachments` 集合，按保留期限删除。
- 老师端界面 `app/src/VisitPage.tsx`：选学生（本机已有签字索引或已收到的问诊）→ “您说，智能体记”一段话、智能体拆进望闻问切四格（拆出来的格子标“听到了，待您确认”，点格子可改）→ “说完了，看草稿” → 复用 `SignReview.tsx` 逐块确认与一键签字。截图 `docs/screenshots/phone-teacher-visit.png`。
- 验收测试：`app/src/core/record/in-person.test.ts`（5 项，合成身份与合成病历）。
- 本机集合：`in-person-draft`（进行中的面诊草稿，含代录原文与附件索引；V2-05 起按老师设定的保留期限删除）。
- V2 起发不出就保留资料、由老师在当前会话重试，不再有 `record-outbox` 待发集合与多步销毁。

M1-20：面诊页面将 record.signed 接入共享 transport；发送失败保留原文，可在当前会话重发。面诊照片由 core/inbox.sendInPersonRecord 在签名病历后逐张加密交还；每张带同一签名病历，学生验签、核对本人收件人和原引用的 SHA-256/长度后落盘。发送成功后老师端保留原件（按保留期限删除）。
