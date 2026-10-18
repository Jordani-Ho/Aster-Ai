# 病历格式约定（Encounter）

- 版本：1（2026-10-16）
- 依据：技术白皮书 §4.3、§5.2、§5.3、§6.1、§6.2；宪章第十四、十六条
- 使用者：M1-09（学生采集）、M1-10（老师起草）、M1-11（签字与交还）、M1-13（作业与打卡）、M1-14（扣费关联病历）
- 修改：B 类，须经技术合伙人同意；施工者照抄类型定义，不要各自改动。

## 1. 类型定义

下面的定义已经放在 `app/src/core/record/types.ts`（由技术合伙人建立，与本文逐字一致）。各任务卡直接引用，不要重复定义；发现问题在合并请求里提出。

```ts
/** 每个字段的来源。界面用颜色区分；AI 推测永远不能显示成事实。 */
export type Source = 'student' | 'teacher' | 'ai_draft' | 'external' | 'unknown'

/** value 为 null 表示“未知”；AI 不得悄悄补全。 */
export interface Field<T> { value: T | null; source: Source; note?: string }

export interface Encounter {
  id: string                 // 32 位随机十六进制
  version: number            // 1, 2, 3…… 签字后再改就生成新版本
  supersedes?: string        // 上一版本的签名事件 id
  kind: 'remote_async' | 'in_person' | 'remote_live'
  student: string            // 学生公钥（64 位十六进制）
  teacher: string            // 老师公钥
  createdAt: string          // ISO 8601
  profile: {                 // 宪章第十四条：老师端只留这些
    alias: Field<string>
    gender: Field<'male' | 'female' | 'other'>
    age: Field<number>
    bazi: Field<{ year: string | null; month: string | null; day: string; hour: string | null; flags: string[] }>
    city: Field<string>
    managedBy?: Field<string>  // M1-22：家人代管问诊时填代管人的称呼；本人问诊省略。只做展示，不参与签字校验
  }
  intake: {                  // 原始资料：只能来自学生（source = 'student'）
    chiefComplaint: Field<string>
    presentIllness: Field<string>
    history: Field<string>
    medsAllergies: Field<string>
    attachments: AttachmentRef[]
  }
  fourExams: { look: Field<string>; listenSmell: Field<string>; ask: Field<string>; pulse: Field<string> }
  judgment: {
    symptomSummary: Field<string>  // 症状的抽象描述，不含原话；签字后老师端保留的就是这一项
    pattern: Field<string>         // 证候
    mechanism: Field<string>       // 病机
    rationale: Field<string>       // 辨证依据
  }
  plan: {
    principle: Field<string>       // 治则治法
    prescription: Field<Prescription>
    homework: Homework[]           // 作业（非药物建议），M1-13 据此提醒
    advice: Field<string>          // 医嘱
  }
  outcome?: { change: Field<string>; adverse: Field<string>; next: Field<string> }
}

export interface Prescription {
  items: { herb: string; dose: string; note?: string }[]
  method?: string                  // 煎服法
  days?: number
  changeReason?: string            // 改方时必须填写（白皮书 §5.3 第 3 条）
  previousOf?: string              // 上一版方子所在的签名事件 id
}

export interface Homework {
  id: string
  title: string                    // 例如“按揉太渊穴”
  detail: string
  schedule:
    | { kind: 'daily'; time: string }                  // 每天 HH:MM
    | { kind: 'shichen'; shichen: string }             // 每天某个时辰，例如 '酉'
    | { kind: 'jieqi'; jieqi: string }                 // 某个节气当天
    | { kind: 'once'; date: string; time?: string }    // 某一天
  durationDays?: number            // 持续多少天；省略表示直到下次复诊
  source: 'teacher' | 'ai_draft'   // 2026-10-16 补：作业也要有来源标签
  note?: string                    // 老师接受 AI 草稿时写 'ai_accepted'
}

export interface AttachmentRef { id: string; type: 'photo' | 'audio'; sha256: string; bytes: number }
```

> 修订记录：2026-10-16 给 `Homework` 补上 `source` 和 `note`（M1-10 审核时发现遗漏）。

## 2. 签名后的病历

签字后的病历是一条 **kind 2730** 的 Nostr 签名事件，由老师私钥签名，复用 `nostr-tools`，做法与康币账本（kind 2729）相同：

- `content` = `JSON.stringify(encounter)`。校验时直接对收到的 `content` 字符串验签，**不需要**再做规范化；验签通过后再解析。
- `tags` = `[['encounter', encounter.id, String(encounter.version)], ['p', encounter.student]]`
- 事件 `id` 就是这份病历的哈希。康币扣费的 `recordHash`、改方的 `previousOf`、新版本的 `supersedes` 都引用它。
- 这类事件只作为礼物包裹的内层传输，从不裸发到中继。

## 3. 三条硬规则（写进代码，不只写进提示词）

1. **签字前，判断和处理部分不能留有 `ai_draft`。** 签字界面要求老师逐项确认：接受时，来源改为 `teacher`，并在 `note` 里写 `ai_accepted`；修改时，来源改为 `teacher`。只要 `judgment`、`plan`、`fourExams` 里还有一项是 `ai_draft`，签字按钮就不可用，签名函数也直接拒绝。`plan.homework` 里的每一条作业同样适用：接受或修改后来源改为 `teacher`，还有一条是 `ai_draft` 就不能签字。
2. **`intake` 只能来自学生。** 老师智能体起草时不得改写 `intake` 和 `profile`。唯一例外是面诊（`kind: 'in_person'`）：学生在老师面前，主诉由老师代录，来源为 `teacher`、`note` 为 `in_person`，学生端标“老师代录”（2026-10-17，M1-12）。
3. **学生端只显示有有效签名的病历和医嘱**，并且签名人必须是这位学生自己的老师。

## 4. 问诊包（学生发给老师）

```ts
export interface ConsultPackage {
  encounter: Encounter          // 只填了 profile 和 intake，来源都是 'student'
  manager?: string              // M1-22 传输元数据：家人代管问诊时为代管人（根身份）公钥，不进病历、不参与签字
  history: string[]             // 学生授权附带的历史病历（签名事件 JSON 字符串），默认同一位老师的近 3 次
  attachments: { ref: AttachmentRef; data: Uint8Array }[]
}
```

M1-05 合并后，经应用信封类型 `consult.package` 传输；签名病历用 `record.signed` 传输。
