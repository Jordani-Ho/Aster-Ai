# M1-10 老师智能体起草

- 状态：待领
- 依赖：M1-07（已完成）。传输部分依赖 M1-05：已合并就接上，未合并就留接口，在 PR 里说明。
- 白皮书依据：§5.2 第 5 步、§5.3、§6.1、§6.2、§6.3
- 共用约定：`docs/schemas/encounter.md`，类型在 `app/src/core/record/types.ts`（已存在，直接引用）

## 目标

老师收到学生的问诊包后，智能体按老师的模板，参考老师自己的医案，起草病历的判断和处理部分，交给老师审改。**只起草，不定论，不签字。**

## 范围

要做的：
1. **老师模板**（`domain/tcm/templates/`）：
   - 定义模板格式 `TeacherTemplate`：`{ id, name, recordOrder: 字段路径数组, focus: string[]（老师特别关注的问题）, prescriptionStyle?: string, notes: string }`；
   - 提供一份默认模板 `default.json`，按十问歌的顺序组织；
   - 格式写进 `domain/tcm/templates/README.md`。
2. **提示词**（`prompts/teacher/draft-encounter.md`）：写明用途、输入、输出的 JSON 结构、禁止事项。必须包含：
   - 只填写 `fourExams`、`judgment`、`plan`，不得改动 `intake` 和 `profile`；
   - 资料不足时填 `null`，不得编造；
   - 不得承诺疗效，不得出现“治愈”“包治”。
3. **医案检索**（`app/src/core/drafting/cases.ts`）：在老师本机的去标识医案里，按主诉和证候做关键词检索（M1 不用向量库），取最相近的 3 份作为范例。医案的存取由 M1-11 实现，本卡只读，测试用合成医案。
4. **起草函数** `draftEncounter(pkg, template, cases, llm) → Encounter`：
   - 调用 M1-07 的模型客户端；
   - 把模型输出**逐字段校验**后写回：AI 填写的字段，来源一律标为 `ai_draft`；模型改动 `intake` 或 `profile` 的部分直接丢弃；格式不对的字段置为 `null` 并在 `note` 里注明；
   - 模型调用失败时返回只含学生资料的草稿，并给出明确的错误提示，不能卡住。
5. **放权开关**（白皮书 §6.2）：老师设置智能体起草到哪一档：`record`（只整理病历，默认）、`pattern`（加辨证建议）、`prescription`（加方子草案）。档位以外的字段，即使模型输出了也丢弃。

不做的：
- 审改和签字界面（M1-11）；
- 医案的写入（M1-11）；
- 学生端采集（M1-09）。

## 验收用例

1. 用模拟的模型回复：正常回复被正确写入，所有 AI 填写的字段来源都是 `ai_draft`。
2. 模拟回复里改写了 `intake.chiefComplaint`：结果里的 `intake` 与问诊包完全一致。
3. 模拟回复里缺少证候：`judgment.pattern.value` 为 `null`，不出现编造的内容。
4. 放权档位为 `record` 时，回复里的方子被丢弃；档位为 `prescription` 时保留。
5. 模拟回复不是合法 JSON，或者模型调用超时：返回只含学生资料的草稿，并带错误提示。
6. 医案检索：在 5 份合成医案里检索“失眠 心脾两虚”，排在前面的是相关的医案。
7. 提示词文件里包含任务卡第 2 条列出的全部禁止事项（用测试检查关键句）。
8. 全部测试使用合成数据和模拟模型，不访问真实网关。

## 完成记录

- 合并请求：https://github.com/Jordani-Ho/Aster-Ai/pull/10
- 结果：已提交老师模板、提示词、逐字段起草校验、档位过滤及本机医案检索；按审核意见 rebase main，检索改为汉字二元组匹配，开方档接纳作业并强制 AI 草稿、本机生成 id、丢弃非法日程；测试与验证见 PR，未合并。
