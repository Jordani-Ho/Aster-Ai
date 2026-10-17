import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import type { Encounter, Field } from './types'

// 签字病历是一条 kind 2730 的 Nostr 签名事件，content 是完整的 Encounter JSON。
// 这个模块（及其依赖）不得导入 core/llm：签字路径里不允许出现任何模型调用。
export const SIGNED_ENCOUNTER_KIND = 2730

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/

export interface SignedEncounterEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface SignedEncounter {
  event: SignedEncounterEvent
  encounter: Encounter
}

// 老师端签字后只保留这条索引，不留病历内容（事件 content 里是学生原话与附件索引）。
export interface SignedEncounterIndex {
  eventId: string
  encounterId: string
  version: number
  student: string
  createdAt: string
}

export interface CaseBookEntry {
  gender: Encounter['profile']['gender']['value']
  ageBand: string | null
  judgment: Encounter['judgment']
  plan: Encounter['plan']
  outcome?: Encounter['outcome']
}

export interface ModificationLogEntry {
  path: string
  aiDraft: unknown
  final: unknown
}

const FOUR_EXAM_KEYS = ['look', 'listenSmell', 'ask', 'pulse'] as const
const JUDGMENT_KEYS = ['symptomSummary', 'pattern', 'mechanism', 'rationale'] as const
const OUTCOME_KEYS = ['change', 'adverse', 'next'] as const
const INTAKE_KEYS = ['chiefComplaint', 'presentIllness', 'history', 'medsAllergies'] as const

function isField(value: unknown): value is Field<unknown> {
  return typeof value === 'object' && value !== null && 'source' in value
}

// 返回仍是 AI 草稿的字段路径；有一条就不能签字。学生端也用它做纵深防御。
export function pendingDraftFields(encounter: Encounter): string[] {
  const pending: string[] = []
  for (const key of FOUR_EXAM_KEYS) if (encounter.fourExams[key].source === 'ai_draft') pending.push('fourExams.' + key)
  for (const key of JUDGMENT_KEYS) if (encounter.judgment[key].source === 'ai_draft') pending.push('judgment.' + key)
  if (encounter.plan.principle.source === 'ai_draft') pending.push('plan.principle')
  if (encounter.plan.prescription.source === 'ai_draft') pending.push('plan.prescription')
  if (encounter.plan.advice.source === 'ai_draft') pending.push('plan.advice')
  encounter.plan.homework.forEach((item, index) => {
    if (item.source === 'ai_draft') pending.push('plan.homework[' + index + ']')
  })
  if (encounter.outcome) {
    for (const key of OUTCOME_KEYS) if (encounter.outcome[key].source === 'ai_draft') pending.push('outcome.' + key)
  }
  return pending
}

// 病历格式第 3 节第 2 条硬规则：intake 只能来自学生（或未知），老师端不得改写。
export function studentIntakeSources(encounter: Encounter): string[] {
  const wrong: string[] = []
  for (const key of INTAKE_KEYS) {
    const source = encounter.intake[key]?.source
    if (source !== 'student' && source !== 'unknown') wrong.push('intake.' + key)
  }
  return wrong
}

function validateEncounter(encounter: Encounter): void {
  if (!HEX32.test(encounter.id)) throw new Error('病历 id 必须是 32 位十六进制')
  if (!Number.isSafeInteger(encounter.version) || encounter.version < 1) throw new Error('病历版本号无效')
  if (!HEX64.test(encounter.student) || !HEX64.test(encounter.teacher)) throw new Error('病历中的公钥格式无效')
}

export function signEncounter(encounter: Encounter, privateKey: Uint8Array): SignedEncounterEvent {
  if (!encounter || typeof encounter !== 'object' || !encounter.fourExams || !encounter.judgment || !encounter.plan) {
    throw new Error('病历结构无效')
  }
  const pending = pendingDraftFields(encounter)
  if (pending.length > 0) throw new Error('还有未确认的 AI 草稿字段：' + pending.join('、'))
  const wrongIntake = studentIntakeSources(encounter)
  if (wrongIntake.length > 0) throw new Error('intake 只能来自学生，不能签字：' + wrongIntake.join('、'))
  validateEncounter(encounter)
  if (getPublicKey(privateKey) !== encounter.teacher) throw new Error('签名人不是病历里的老师')
  const created = Date.parse(encounter.createdAt)
  if (!Number.isFinite(created)) throw new Error('病历时间无效')
  const event = finalizeEvent({
    kind: SIGNED_ENCOUNTER_KIND,
    created_at: Math.floor(created / 1000),
    tags: [['encounter', encounter.id, String(encounter.version)], ['p', encounter.student]],
    content: JSON.stringify(encounter),
  }, privateKey)
  return event as SignedEncounterEvent
}

export interface VerifyOptions {
  student: string
  teacher: string
}

// 学生端校验：签名有效、签名人是自己的老师、p 标签是自己，才接受。
// 纵深防御：即使签名有效，intake 来源不对或仍带 ai_draft 的病历也拒绝。
export function verifySignedEncounter(event: SignedEncounterEvent, options: VerifyOptions): Encounter {
  if (!event || typeof event !== 'object') throw new Error('签名病历格式无效')
  if (event.kind !== SIGNED_ENCOUNTER_KIND) throw new Error('不是签字病历事件')
  // nostr-tools 的 verifyEvent 会缓存已验证标记；先重算 id，确认 content 与 id 绑定（见 team/mistakes E-004）。
  let idMatches = false
  try {
    idMatches = getEventHash(event) === event.id
  } catch {
    idMatches = false
  }
  if (!idMatches) throw new Error('病历内容与事件 id 不一致，可能被篡改')
  if (!verifyEvent(event)) throw new Error('签名校验失败')
  let encounter: Encounter
  try {
    encounter = JSON.parse(event.content) as Encounter
  } catch {
    throw new Error('病历内容不是合法 JSON')
  }
  if (!encounter || typeof encounter !== 'object') throw new Error('病历内容无效')
  if (!encounter.fourExams || !encounter.judgment || !encounter.plan || !encounter.intake) throw new Error('病历结构无效')
  if (encounter.student !== options.student) throw new Error('这份病历不属于当前学生')
  if (event.pubkey !== options.teacher) throw new Error('签名人不是这位学生的老师')
  if (encounter.teacher !== event.pubkey) throw new Error('病历里的老师与签名人不一致')
  const pTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === 'p')?.[1]
  if (pTag !== options.student) throw new Error('p 标签不是当前学生')
  const encounterTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === 'encounter')
  if (!encounterTag || encounterTag[1] !== encounter.id || encounterTag[2] !== String(encounter.version)) {
    throw new Error('encounter 标签与病历内容不一致')
  }
  const pending = pendingDraftFields(encounter)
  if (pending.length > 0) throw new Error('签名病历里还有未确认的 AI 草稿：' + pending.join('、'))
  const wrongIntake = studentIntakeSources(encounter)
  if (wrongIntake.length > 0) throw new Error('intake 来源不是学生，拒绝接收：' + wrongIntake.join('、'))
  return encounter
}

function ageBand(age: number | null): string | null {
  if (age === null || !Number.isFinite(age) || age < 0) return null
  const low = Math.floor(age / 10) * 10
  return low + '-' + (low + 9) + ' 岁'
}

// 去标识医案：只含判断、处理、结果与性别/年龄段，不含学生公钥、称呼、intake 原文和附件。
export function deidentifiedCaseBook(encounter: Encounter): CaseBookEntry {
  const entry: CaseBookEntry = {
    gender: encounter.profile.gender.value,
    ageBand: ageBand(encounter.profile.age.value),
    judgment: encounter.judgment,
    plan: encounter.plan,
  }
  if (encounter.outcome) entry.outcome = encounter.outcome
  return entry
}

function valueAt(encounter: Encounter, path: string): unknown {
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let current: unknown = encounter
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function plainValue(value: unknown): unknown {
  return isField(value) ? value.value : value
}

// “草案 → 定稿”修改记录：只留 judgment 与 plan 的字段。
// fourExams 常转述学生原话，与去标识医案的范围保持一致，不记录。
export function modificationLog(draft: Encounter, final: Encounter): ModificationLogEntry[] {
  return pendingDraftFields(draft)
    .filter(path => path.startsWith('judgment.') || path.startsWith('plan.'))
    .map(path => ({
      path,
      aiDraft: plainValue(valueAt(draft, path)),
      final: plainValue(valueAt(final, path)),
    }))
}

// 修改已签字病历：同一份病历共用 id（靠 version 区分），只把 version + 1，
// supersedes 指向上一版的签名事件 id。
export function nextVersion(
  previous: Encounter,
  previousEventId: string,
  updates: { createdAt?: string; judgment?: Encounter['judgment']; plan?: Encounter['plan']; outcome?: Encounter['outcome'] } = {},
): Encounter {
  if (!HEX32.test(previous.id)) throw new Error('病历 id 格式无效')
  if (!HEX64.test(previousEventId)) throw new Error('上一版签名事件 id 格式无效')
  return {
    ...previous,
    version: previous.version + 1,
    supersedes: previousEventId,
    createdAt: updates.createdAt ?? new Date().toISOString(),
    ...(updates.judgment ? { judgment: updates.judgment } : {}),
    ...(updates.plan ? { plan: updates.plan } : {}),
    ...(updates.outcome ? { outcome: updates.outcome } : {}),
  }
}
