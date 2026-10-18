import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import type { LlmClient } from '../llm'
import { check, type RedFlagResult } from '../redflags'
import type { AttachmentRef, ConsultPackage, Encounter, Field } from '../record/types'
import { emptyFields, missingFocuses, organizeIntake, MAX_ROUNDS, INTAKE_KEYS, type FollowupQuestion, type IntakeFields, type IntakeKey } from './followup'
import { MAX_PHOTOS, assertPhotoCount, type PhotoResult } from './photo'

// 学生采集流程：说话 → 本地急症筛查 → 整理与追问 → 确认页核对 → 明确点“确认发送”才调用 send。
// 点之前没有任何数据离开手机；模型只用学生原话做摘取，确认发送的代码路径不调用模型。

export type IntakePhase = 'collecting' | 'confirm' | 'sent'
export interface FocusRecord { status: 'answered' | 'skipped'; text?: string }

export interface IntakeSession {
  encounterId: string
  templateId: string
  student: string
  teacher: string
  kind: 'remote_async'
  createdAt: string
  focusOrder: string[]
  texts: string[]
  answers: Record<string, FocusRecord>
  fields: IntakeFields
  questions: FollowupQuestion[]
  round: number
  emergency: RedFlagResult | null
  phase: IntakePhase
  reviewed: boolean
  usedFallback: boolean
  attachments: AttachmentRef[]
}

export interface IntakeStore {
  put(collection: string, key: string, value: unknown): Promise<void>
  get(collection: string, key: string): Promise<unknown>
  list(collection: string): Promise<{ key: string; value: unknown }[]>
  delete(collection: string, key: string): Promise<void>
}

// 学生端本地集合，登记在 app/src/core/store/README.md。
export const INTAKE_COLLECTIONS = {
  draft: 'intake-draft',
  sent: 'intake-sent',
  outbox: 'intake-outbox',
  attachmentData: 'intake-attachments',
  profile: 'profile',
  studentRecords: 'student-records',
} as const

// 本机留存的问诊包副本：附件字节单独存二进制记录，元数据保持 JSON。
export interface StoredPackage { encounter: Encounter; history: string[]; attachments: AttachmentRef[] }

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

function textField(value: string | null): Field<string> {
  return value === null ? { value: null, source: 'unknown' } : { value, source: 'student' }
}

export function emptyProfile(): Encounter['profile'] {
  return {
    alias: { value: null, source: 'unknown' },
    gender: { value: null, source: 'unknown' },
    age: { value: null, source: 'unknown' },
    bazi: { value: null, source: 'unknown' },
    city: { value: null, source: 'unknown' },
  }
}

// 问诊包上的急症标记：只给老师端看，不进 Encounter schema（M1-19）。
export interface RedFlagMark { hit: boolean; crisis: boolean }

function redFlagMark(result: RedFlagResult | null): RedFlagMark | null {
  if (!result || !result.hit) return null
  return { hit: true, crisis: result.actions.includes('crisis') }
}

export function startSession(options: { student: string; teacher: string; template: TeacherTemplate; now?: Date; id?: string }): IntakeSession {
  const { student, teacher, template } = options
  if (!HEX64.test(student) || !HEX64.test(teacher)) throw new Error('公钥格式无效')
  if (!template || !Array.isArray(template.focus) || template.focus.length === 0) throw new Error('老师模板无效')
  const id = options.id ?? randomHex(16)
  if (!HEX32.test(id)) throw new Error('病历 id 格式无效')
  const createdAt = (options.now ?? new Date()).toISOString()
  return {
    encounterId: id,
    templateId: template.id,
    student,
    teacher,
    kind: 'remote_async',
    createdAt,
    focusOrder: [...template.focus],
    texts: [],
    answers: {},
    fields: emptyFields(),
    questions: [],
    round: 0,
    emergency: null,
    phase: 'collecting',
    reviewed: false,
    usedFallback: false,
    attachments: [],
  }
}

// 每说一句都先过本地急症筛查；命中只记录标记（M1-19 起不再阻断），发送前仍会再查一遍。
export function addUtterance(state: IntakeSession, text: string): IntakeSession {
  if (state.phase !== 'collecting') throw new Error('这次采集已经进入确认页')
  const value = text.trim()
  if (value === '') throw new Error('这句话还是空的')
  if (value.length > 2000) throw new Error('一次说得太长了，请分几次说')
  const result = check(value)
  const texts = [...state.texts, value]
  return { ...state, texts, emergency: result.hit ? result : state.emergency, reviewed: false }
}

function assertFocus(state: IntakeSession, focus: string): void {
  if (!state.focusOrder.includes(focus)) throw new Error('没有这个追问项目')
  if (state.answers[focus]) throw new Error('这一项已经处理过了')
}

export function answerFocus(state: IntakeSession, focus: string, text: string): IntakeSession {
  assertFocus(state, focus)
  const value = text.trim()
  if (value === '') throw new Error('回答还是空的')
  if (value.length > 2000) throw new Error('一次说得太长了，请分几次说')
  const result = check(value)
  const answers = { ...state.answers, [focus]: { status: 'answered' as const, text: value } }
  const questions = state.questions.filter(question => question.focus !== focus)
  return { ...state, answers, questions, emergency: result.hit ? result : state.emergency, reviewed: false }
}

export function skipFocus(state: IntakeSession, focus: string): IntakeSession {
  assertFocus(state, focus)
  return {
    ...state,
    answers: { ...state.answers, [focus]: { status: 'skipped' as const } },
    questions: state.questions.filter(question => question.focus !== focus),
    reviewed: false,
  }
}

// 整理与追问：有模型时走模型，失败或断网时用固定问句；最多 3 轮，之后直接进确认页。
export async function organizeSession(
  state: IntakeSession,
  llm: LlmClient | null | undefined,
  options: { timeoutMs?: number; member?: { age: number | null } } = {},
): Promise<IntakeSession> {
  if (state.phase === 'sent') throw new Error('这次采集已经发送')
  const focusAnswers: Record<string, string> = {}
  for (const [focus, record] of Object.entries(state.answers)) {
    if (record.status === 'answered' && record.text) focusAnswers[focus] = record.text
  }
  const missing = missingFocuses(state.focusOrder, state.answers)
  const template: TeacherTemplate = { id: state.templateId, name: '', recordOrder: [], focus: state.focusOrder, notes: '' }
  const outcome = await organizeIntake(llm, {
    texts: state.texts,
    focusAnswers,
    focusOrder: state.focusOrder,
    missingFocus: missing,
    template,
    ...(options.member ? { member: options.member } : {}),
  }, options)
  const round = state.round + (outcome.questions.length > 0 ? 1 : 0)
  const questions = round > MAX_ROUNDS ? [] : outcome.questions
  const phase: IntakePhase = questions.length === 0 ? 'confirm' : 'collecting'
  return {
    ...state,
    fields: outcome.fields,
    questions,
    round,
    phase,
    reviewed: false,
    usedFallback: outcome.usedFallback,
  }
}

// 确认页展示后调用；没看过整理结果就不能进问诊包。
export function markReviewed(state: IntakeSession): IntakeSession {
  if (state.phase !== 'confirm') throw new Error('整理还没完成')
  return { ...state, reviewed: true }
}

export function updateField(state: IntakeSession, key: IntakeKey, value: string): IntakeSession {
  if (!INTAKE_KEYS.includes(key)) throw new Error('没有这个采集字段')
  if (state.phase !== 'confirm') throw new Error('还在采集中，暂时不能修改')
  const trimmed = value.trim()
  if (trimmed.length > 2000) throw new Error('这一项太长了，请精简一下')
  const fields = { ...state.fields, [key]: textField(trimmed === '' ? null : trimmed) }
  // 学生在确认页改写的文字同样过本地急症红线；命中只记录标记，不阻断（M1-19）。
  const result = check(trimmed)
  return { ...state, fields, emergency: result.hit ? result : state.emergency }
}

export function addPhoto(state: IntakeSession, photo: PhotoResult): IntakeSession {
  if (state.phase === 'sent') throw new Error('这次采集已经发送')
  assertPhotoCount(state.attachments.length)
  return { ...state, attachments: [...state.attachments, photo.ref] }
}

export function removePhoto(state: IntakeSession, refId: string): IntakeSession {
  return { ...state, attachments: state.attachments.filter(ref => ref.id !== refId) }
}

export interface ConfirmCheck { ok: boolean; reason?: string }

export function canConfirm(state: IntakeSession): ConfirmCheck {
  if (state.phase === 'sent') return { ok: false, reason: '这次采集已经发送过了' }
  if (state.phase !== 'confirm') return { ok: false, reason: '还没到确认页' }
  if (!state.reviewed) return { ok: false, reason: '请先在确认页核对整理后的内容' }
  if (state.attachments.length > MAX_PHOTOS) return { ok: false, reason: '照片太多' }
  return { ok: true }
}

// 急症提示点“我已知晓”后可以重新开始一次采集。
export function restartAfterEmergency(state: IntakeSession, now: Date = new Date()): IntakeSession {
  return startSession({
    student: state.student,
    teacher: state.teacher,
    template: { id: state.templateId, name: '', recordOrder: [], focus: state.focusOrder, notes: '' },
    now,
  })
}

export interface HistoryCandidate { id: string; teacher: string; createdAt: string; eventJson: string }

function isHistoryCandidate(value: unknown): value is HistoryCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as HistoryCandidate
  return typeof candidate.id === 'string' && typeof candidate.teacher === 'string'
    && typeof candidate.createdAt === 'string' && Number.isFinite(Date.parse(candidate.createdAt))
    && typeof candidate.eventJson === 'string' && candidate.eventJson !== ''
}

// 默认可附带的历史病历：同一位老师的近 3 次（按学生本机收到时间倒序）。
export function defaultHistorySelection(candidates: readonly HistoryCandidate[], teacher: string): HistoryCandidate[] {
  return candidates
    .filter(candidate => candidate.teacher === teacher)
    .slice()
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id))
    .slice(0, 3)
}

export function buildConsultPackage(
  state: IntakeSession,
  profile: Encounter['profile'],
  history: readonly HistoryCandidate[],
  attachments: readonly { ref: AttachmentRef; data: Uint8Array }[],
  trend?: ConsultPackage['trend'],
  options: { manager?: string; managerProof?: ConsultPackage['managerProof'] } = {},
): ConsultPackage {
  const checkResult = canConfirm(state)
  if (!checkResult.ok) throw new Error(checkResult.reason)
  // 纵深防御：发送前把 intake 全部字段再过一遍急症红线，命中就标记，不阻断（M1-19）。
  let redFlag: RedFlagMark | null = redFlagMark(state.emergency)
  for (const key of INTAKE_KEYS) {
    const value = state.fields[key].value
    if (value !== null && value !== '') {
      const hit = check(value)
      if (hit.hit) redFlag = { hit: true, crisis: (redFlag?.crisis ?? false) || hit.actions.includes('crisis') }
    }
  }
  for (const candidate of history) {
    if (candidate.teacher !== state.teacher) throw new Error('附带的病历不是这位老师的')
  }
  if (attachments.length !== state.attachments.length) throw new Error('附件与确认页不一致')
  for (const [index, expected] of state.attachments.entries()) {
    const given = attachments[index]
    if (!given || given.ref.id !== expected.id || given.ref.sha256 !== expected.sha256
      || given.ref.bytes !== expected.bytes || given.ref.type !== expected.type
      || given.data.length !== expected.bytes) {
      throw new Error('附件与确认页不一致')
    }
  }
  const unknown = <T,>(): Field<T> => ({ value: null, source: 'unknown' })
  const encounter: Encounter = {
    id: state.encounterId,
    version: 1,
    kind: state.kind,
    student: state.student,
    teacher: state.teacher,
    createdAt: state.createdAt,
    profile: structuredClone(profile),
    intake: {
      chiefComplaint: structuredClone(state.fields.chiefComplaint),
      presentIllness: structuredClone(state.fields.presentIllness),
      history: structuredClone(state.fields.history),
      medsAllergies: structuredClone(state.fields.medsAllergies),
      attachments: state.attachments.map(ref => ({ ...ref })),
    },
    fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
    judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
    plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
  }
  const pkg: ConsultPackage = {
    encounter,
    history: history.map(candidate => candidate.eventJson),
    attachments: attachments.map(item => ({ ref: { ...item.ref }, data: item.data })),
    ...(redFlag ? { redFlag } : {}),
    ...(trend ? { trend } : {}),
  }
  // M1-22：家人代管问诊时带上代管人公钥与代管证明，只走传输元数据，不改病历 schema。
  if (options.manager !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(options.manager)) throw new Error('代管人公钥格式无效')
    if (options.managerProof === undefined) throw new Error('缺少代管证明，不能替家人问诊')
    pkg.manager = options.manager
    pkg.managerProof = structuredClone(options.managerProof)
  }
  return pkg
}

export async function saveStoredPackage(store: IntakeStore, pkg: ConsultPackage, collection: string, encounterId: string): Promise<StoredPackage> {
  for (const item of pkg.attachments) await store.put(INTAKE_COLLECTIONS.attachmentData, item.ref.id, item.data)
  const stored: StoredPackage = {
    encounter: pkg.encounter,
    history: pkg.history,
    attachments: pkg.attachments.map(item => ({ ...item.ref })),
  }
  await store.put(collection, encounterId, stored)
  return stored
}

export type SendConsultPackage = (pkg: ConsultPackage) => Promise<void>

export async function confirmAndSend(
  store: IntakeStore,
  state: IntakeSession,
  profile: Encounter['profile'],
  history: readonly HistoryCandidate[],
  attachments: readonly { ref: AttachmentRef; data: Uint8Array }[],
  send: SendConsultPackage,
  trend?: ConsultPackage['trend'],
  options: { manager?: string; managerProof?: ConsultPackage['managerProof'] } = {},
): Promise<ConsultPackage> {
  const pkg = buildConsultPackage(state, profile, history, attachments, trend, options)
  // 只有学生明确点“确认发送”才走到这里；之前任何一步都不调用 send。
  await send(pkg)
  await saveStoredPackage(store, pkg, INTAKE_COLLECTIONS.sent, state.encounterId)
  await store.delete(INTAKE_COLLECTIONS.draft, state.encounterId)
  return pkg
}

export async function saveDraft(store: IntakeStore, state: IntakeSession): Promise<void> {
  if (state.phase === 'sent') throw new Error('已发送的采集不再保存草稿')
  await store.put(INTAKE_COLLECTIONS.draft, state.encounterId, state)
}

function isSession(value: unknown): value is IntakeSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const session = value as IntakeSession
  return HEX32.test(session.encounterId) && typeof session.student === 'string' && typeof session.teacher === 'string'
    && Array.isArray(session.focusOrder) && Array.isArray(session.texts) && Array.isArray(session.attachments)
    && (session.phase === 'collecting' || session.phase === 'confirm')
    && typeof session.fields === 'object' && session.fields !== null
}

export async function loadDraft(store: IntakeStore): Promise<IntakeSession | null> {
  const rows = await store.list(INTAKE_COLLECTIONS.draft)
  const sessions = rows.map(row => row.value).filter(isSession)
  if (sessions.length === 0) return null
  sessions.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  return sessions[0]
}

export async function deleteDraft(store: IntakeStore, encounterId: string): Promise<void> {
  await store.delete(INTAKE_COLLECTIONS.draft, encounterId)
}

function isField(value: unknown): value is Field<unknown> {
  return typeof value === 'object' && value !== null && 'value' in value && 'source' in value
}

function isProfile(value: unknown): value is Encounter['profile'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const profile = value as Record<string, unknown>
  return ['alias', 'gender', 'age', 'bazi', 'city'].every(key => isField(profile[key]))
    && (profile.managedBy === undefined || isField(profile.managedBy))
}

export async function loadProfile(store: IntakeStore): Promise<Encounter['profile']> {
  const value = await store.get(INTAKE_COLLECTIONS.profile, 'self')
  return isProfile(value) ? value : emptyProfile()
}

export async function saveProfile(store: IntakeStore, profile: Encounter['profile']): Promise<void> {
  await store.put(INTAKE_COLLECTIONS.profile, 'self', profile)
}

export async function loadHistory(store: IntakeStore, teacher: string): Promise<HistoryCandidate[]> {
  const rows = await store.list(INTAKE_COLLECTIONS.studentRecords)
  return rows.map(row => row.value).filter((value): value is HistoryCandidate => isHistoryCandidate(value) && value.teacher === teacher)
}
