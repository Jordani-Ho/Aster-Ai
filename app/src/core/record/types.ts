// 病历格式约定（Encounter）v1。定义来源：docs/schemas/encounter.md，修改须同步该文档（B 类）。
// 由技术合伙人建立；M1-09、M1-10、M1-11、M1-13、M1-14 直接引用，不要重复定义。

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

export interface ConsultPackage {
  encounter: Encounter          // 只填了 profile 和 intake，来源都是 'student'
  history: string[]             // 学生授权附带的历史病历（签名事件 JSON 字符串），默认同一位老师的近 3 次
  attachments: { ref: AttachmentRef; data: Uint8Array }[]
  /** 急症/自伤标记（M1-19）：只随传输信封给老师端看，不进 Encounter schema。 */
  redFlag?: { hit: boolean; crisis: boolean }
}
