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

function isField(value: unknown): value is Field<unknown> {
  return typeof value === 'object' && value !== null && 'source' in value
}

// 返回仍是 AI 草稿的字段路径；有一条就不能签字。
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
  return pending
}

function validateEncounter(encounter: Encounter): void {
  if (!HEX32.test(encounter.id)) throw new Error('病历 id 必须是 32 位十六进制')
  if (!Number.isSafeInteger(encounter.version) || encounter.version < 1) throw new Error('病历版本号无效')
  if (!HEX64.test(encounter.student) || !HEX64.test(encounter.teacher)) throw new Error('病历中的公钥格式无效')
}

export function signEncounter(encounter: Encounter, privateKey: Uint8Array): SignedEncounterEvent {
  const pending = pendingDraftFields(encounter)
  if (pending.length > 0) throw new Error('还有未确认的 AI 草稿字段：' + pending.join('、'))
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
  if (encounter.student !== options.student) throw new Error('这份病历不属于当前学生')
  if (event.pubkey !== options.teacher) throw new Error('签名人不是这位学生的老师')
  if (encounter.teacher !== event.pubkey) throw new Error('病历里的老师与签名人不一致')
  const pTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === 'p')?.[1]
  if (pTag !== options.student) throw new Error('p 标签不是当前学生')
  const encounterTag = event.tags.find(tag => Array.isArray(tag) && tag[0] === 'encounter')
  if (!encounterTag || encounterTag[1] !== encounter.id || encounterTag[2] !== String(encounter.version)) {
    throw new Error('encounter 标签与病历内容不一致')
  }
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

// “草案 → 定稿”修改记录：逐字段保留 AI 原文和老师定稿（思想指纹，白皮书 §6.2）。
export function modificationLog(draft: Encounter, final: Encounter): ModificationLogEntry[] {
  return pendingDraftFields(draft).map(path => ({
    path,
    aiDraft: plainValue(valueAt(draft, path)),
    final: plainValue(valueAt(final, path)),
  }))
}

// 修改已签字病历：生成 version + 1 的新病历，supersedes 指向旧版签名事件 id。
export function nextVersion(
  previous: Encounter,
  previousEventId: string,
  updates: { createdAt?: string; judgment?: Encounter['judgment']; plan?: Encounter['plan']; outcome?: Encounter['outcome'] } = {},
): Encounter {
  if (!HEX64.test(previousEventId)) throw new Error('上一版签名事件 id 格式无效')
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  return {
    ...previous,
    id,
    version: previous.version + 1,
    supersedes: previousEventId,
    createdAt: updates.createdAt ?? new Date().toISOString(),
    ...(updates.judgment ? { judgment: updates.judgment } : {}),
    ...(updates.plan ? { plan: updates.plan } : {}),
    ...(updates.outcome ? { outcome: updates.outcome } : {}),
  }
}
