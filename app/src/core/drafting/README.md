# 老师起草

`draftEncounter(pkg, materials, llm, options?)` 直接使用 record/types 的 Encounter 和 ConsultPackage、M1-07 的 LlmClient；materials 是 `{ template, prior?, cases? }`，返回 `{ encounter, note }`（note 是减了材料的提示行）。调用方传入自己的已配置客户端；起草函数不配置凭据、不持久化问诊资料、不签字、不发消息；本机模板读写见下文 template.ts。

options.level 默认 record：只允许四诊与症状摘要。pattern 再允许证候、病机、依据和治则；prescription 再允许方子、作业与医嘱。重起草从学生资料建立全新草稿，不沿用已存在的老师判断或结果。模型字段来源强制 ai_draft，缺失为 unknown/null，非法字段注明原因。

错误通过 onError 回调交给界面，并始终保留在返回病历的 judgment.symptomSummary.note 中，不把上游响应或错误原文写日志。默认等待 30 秒，可用 timeoutMs 调整。超时仅停止等待：M1-07 尚无 AbortSignal 接口，底层请求可能继续，但不会再修改返回草稿。

`searchCases(query, cases)` 只读去标识投影 DraftCase（id、symptomSummary、pattern，改过的医案另带 changeReason 与老师改过的处方）。NFKC 规范化后，对各连续汉字短句取去重二元组，不跨标点或空白；按共同二元组数降序，同分按 id 字典序，最多三份。无共同二元组时不匹配，单字及非汉字不计分；不是语义检索。调用者应只提供当前老师本机医案；不传完整 Encounter。存取留给 M1-11。

作业使用 main 已更新的 Homework 类型，仅在 prescription 档接纳。本机生成随机 id，强制 source=ai_draft，不接纳模型 note。逐条校验 title/detail、正整数 durationDays、四类 schedule；时间严格 HH:MM，日期须有效，时辰须为十二地支，节气须精确匹配 domain/tcm/templates/types.ts 的24节气名称，非法条目整条丢弃，不修补。仅构造类型允许的字段，不进入签字或提醒流程。

没有 M1-05 传输代码，直接接收 ConsultPackage，历史签名与附件校验由接收层负责；本模块不解析历史病历、不读取附件二进制。

测试全部使用合成资料及模拟 LlmClient，无真实网关请求。

M1-20：reviseEncounter(input, instruction, llm) 加载 prompts/teacher/revise-draft.md，只接受 fourExams/judgment/plan/已有 outcome 的字段补丁。省略字段保留原值，value:null 表示明确清空；格式不合法、超时或无有效补丁时抛安全错误且保留整张原卡。更新字段与作业强制 ai_draft，不采纳模型来源、身份、profile、intake、附件或版本；不签字、不发送。V2-22 起 template.ts 只读取统一的本机四类版本模板；旧 settings/teacher-template 仅未发布新版时只读沿用，不再编辑或双写。生效骨架随请求进入模型，留待老师的现有病历块不接纳模型输出。无新依赖。

M1-20 的 draftCarePlan 只把老师的要点整理为 {constitution,points,avoid,source:ai_draft}；模型不能指定版本、时间、签名或确认来源。字段与条数受限，超时/格式错误保留原卡片，提示词为 prompts/teacher/draft-careplan.md。签发交给 careplan/issue.ts 的真人点击回调。

## V2-19 一事一议、只向签字学、额度上限

- **一事一议**：起草、改稿、拆四诊、方案、记账各自一次模型调用，只带这一位学生、这一件事的材料；每次新建 system+user 两条消息，不带上一次调用的对话，也没有模块级缓存。`draftEncounter` 只接收本次的材料对象。
- **材料两堆**：不可减 = 这次问诊包（profile/intake/fourExams）、老师模板、提示词；可减 = 这位学生以前签过字的旧病历（新→旧）与相似医案（最多三份）。旧病历材料由 `materials.ts` 的 `priorMaterials` 从签名病历投影，同一 encounter 只取最新版本，只带证候、方子、医嘱、加减理由等必要内容。
- **额度**：每次调用前用 `budget.ts` 估算（汉字 1 token、其他字符 1/3，向上取整，偏高估），上限读 `domain/tcm/agent-budget.json`（默认 16000 = 常见 32k 上下文的一半）。超了先减旧病历（从最早的减），再减相似医案；减了就写进返回的 note，核对页显示一行小字，不悄悄少带。问诊包与模板永远不减；固定材料本身超限也照发。
- **额度超限**：`core/llm` 的 `isQuotaExceeded` 只认 402/429，不读回复正文。`draftEncounter` 三段降级：正常裁剪 → 上限减半再试一次 → 只剩问诊包与模板（note「没参考旧病历和医案」）→ 仍失败走固定文案回退，不带上游原文。改稿、拆四诊、方案、记账没有可减材料，不做额度重试。
- **只向签字学**：cases 由 `records/teacher.ts` 的 `teacherCases` 提供，只含老师签过字、且老师亲手改过 judgment/plan 的病历（`Field.note` 不是 `ai_accepted`），带改方加减理由；原样确认的病历只计 `teacherCaseStats`，不进相似医案。
- **按意见改稿**：`reviseEncounter` 改到的字段写 `note: teacher_directed`；核对页点“就这样”和签字前的统一确认都保留这个标记（不覆盖成 `ai_accepted`），签字后按“老师改过”进医案。
