import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import { parseTongueAbstract, type TongueAbstract } from '../../../../domain/tcm/tongue'
import { parsePeriodObservation } from '../../../../domain/tcm/observation'
import { removeStudentPostureSegment, sanitizeStudentPostures, type PostureRecord, type PostureSegment } from '../../../../domain/tcm/posture'
import type { LlmClient } from '../llm'
import { isHeavenStamp } from '../heaven/stamp'
import type { AttachmentRef, ConsultPackage, Encounter, Field } from '../record/types'
import { cleanSharedHomeHerbs } from '../herbs'
import { emptyFields, missingFocuses, organizeIntake, MAX_ROUNDS, INTAKE_KEYS, type FollowupQuestion, type IntakeFields, type IntakeKey } from './followup'
import { MAX_PHOTOS, assertPhotoCount, type PhotoResult } from './photo'
import { appendStudentPostureSegment, newStudentPostureRecord } from '../posture'

// 学生采集流程：说话 → 整理与追问 → 确认页核对 → 明确点“确认发送”才调用 send。
// 点之前没有任何数据离开手机；模型只用学生原话做摘取，确认发送的代码路径不调用模型。
// V2-18：采集流程不判断急症/心理状况，只在问诊页顶端常驻一句就医提醒。

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
  phase: IntakePhase
  reviewed: boolean
  usedFallback: boolean
  attachments: AttachmentRef[]
  tongues?: TongueAbstract[]
  /** V2-32：学生在家拍的体态（正面/侧面各一张或一段走路视频）；只有关键点，不带照片，学生端不算指标。 */
  posture?: PostureRecord
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

// 问诊包不再带急症标记（V2-18）。
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
    phase: 'collecting',
    reviewed: false,
    usedFallback: false,
    attachments: [],
  }
}

// 每说一句只记录原话（V2-18：不做任何急症/心理判断）。
export function addUtterance(state: IntakeSession, text: string): IntakeSession {
  if (state.phase !== 'collecting') throw new Error('这次采集已经进入确认页')
  const value = text.trim()
  if (value === '') throw new Error('这句话还是空的')
  if (value.length > 2000) throw new Error('一次说得太长了，请分几次说')
  const texts = [...state.texts, value]
  return { ...state, texts, reviewed: false }
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
  const answers = { ...state.answers, [focus]: { status: 'answered' as const, text: value } }
  const questions = state.questions.filter(question => question.focus !== focus)
  return { ...state, answers, questions, reviewed: false }
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

// V2-29：“跳过，直接整理”= 一次结束追问，直接进确认页；所有还没答的项按“跳过”记。
// 不调用模型、不编造内容：字段保持 unknown，确认页显示“未提供”。
export function skipRemainingFocuses(state: IntakeSession): IntakeSession {
  if (state.phase === 'sent') throw new Error('这次采集已经发送')
  const answers = { ...state.answers }
  for (const focus of state.focusOrder) {
    if (!answers[focus]) answers[focus] = { status: 'skipped' as const }
  }
  return { ...state, answers, questions: [], phase: 'confirm', reviewed: false }
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
  return { ...state, fields }
}

export function addPhoto(state: IntakeSession, photo: PhotoResult): IntakeSession {
  if (state.phase === 'sent') throw new Error('这次采集已经发送')
  assertPhotoCount(state.attachments.length)
  return { ...state, attachments: [...state.attachments, photo.ref] }
}

export function removePhoto(state: IntakeSession, refId: string): IntakeSession {
  return { ...state, attachments: state.attachments.filter(ref => ref.id !== refId) }
}

// V2-08：一次问诊最多附四份舌象（每份带一张裁剪图）。
export const MAX_TONGUES = 4

export function addTongue(state:IntakeSession,record:TongueAbstract):IntakeSession {
 if(state.phase==='sent')throw Error('这次采集已经发送')
 if((state.tongues?.length??0)>=MAX_TONGUES)throw Error('最多附四份舌象示意')
 return {...state,tongues:[...(state.tongues??[]),parseTongueAbstract(record)]}
}

// V2-32：确认页“这次的体态（可空）”——学生拍正面、侧面各一张，或一段走路视频；只留关键点。
export function addPostureSegment(state: IntakeSession, segment: PostureSegment): IntakeSession {
  if (state.phase === 'sent') throw new Error('这次采集已经发送')
  if (state.phase !== 'confirm') throw new Error('到确认页才能拍体态')
  const record = state.posture ?? newStudentPostureRecord(state.student, state.teacher, [])
  return { ...state, posture: appendStudentPostureSegment(record, segment) }
}
export function removePostureSegment(state: IntakeSession, segmentId: string): IntakeSession {
  if (!state.posture) throw new Error('还没有拍体态')
  const next = removeStudentPostureSegment(state.posture, segmentId)
  if (next) return { ...state, posture: next }
  const { posture: _omitted, ...rest } = state
  return rest
}
export function updatePostureNote(state: IntakeSession, segmentId: string, note: string): IntakeSession {
  if (!state.posture) throw new Error('还没有拍体态')
  const text = note.trim().slice(0, 200)
  const segments = state.posture.segments.map(segment => {
    if (segment.id !== segmentId) return segment
    const { note: _old, ...rest } = segment
    return text === '' ? rest : { ...rest, note: text }
  })
  return { ...state, posture: { ...state.posture, segments } }
}

export interface ConfirmCheck { ok: boolean; reason?: string }

export function canConfirm(state: IntakeSession): ConfirmCheck {
  if (state.phase === 'sent') return { ok: false, reason: '这次采集已经发送过了' }
  if (state.phase !== 'confirm') return { ok: false, reason: '还没到确认页' }
  if (!state.reviewed) return { ok: false, reason: '请先在确认页核对整理后的内容' }
  if (state.attachments.length > MAX_PHOTOS) return { ok: false, reason: '照片太多' }
  return { ok: true }
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
  options: { manager?: string; managerProof?: ConsultPackage['managerProof']; heaven?: ConsultPackage['heaven']; observation?: ConsultPackage['observation']; homeHerbs?: ConsultPackage['homeHerbs'] } = {},
): ConsultPackage {
  const checkResult = canConfirm(state)
  if (!checkResult.ok) throw new Error(checkResult.reason)
  for (const candidate of history) {
    if (candidate.teacher !== state.teacher) throw new Error('附带的病历不是这位老师的')
  }
  const crops = (state.tongues ?? []).flatMap(record => record.crop ? [record.crop] : [])
  if (attachments.length !== state.attachments.length + crops.length) throw new Error('附件与确认页不一致')
  for (const [index, expected] of state.attachments.entries()) {
    const given = attachments[index]
    if (!given || given.ref.id !== expected.id || given.ref.sha256 !== expected.sha256
      || given.ref.bytes !== expected.bytes || given.ref.type !== expected.type
      || given.data.length !== expected.bytes) {
      throw new Error('附件与确认页不一致')
    }
  }
  // V2-08：舌头裁剪图走同一条附件通道，只带裁剪图、不带原图。
  for (const [index, expected] of crops.entries()) {
    const given = attachments[state.attachments.length + index]
    if (!given || given.ref.id !== expected.id || given.ref.sha256 !== expected.sha256
      || given.ref.bytes !== expected.bytes || given.ref.type !== 'photo' || given.data.length !== expected.bytes) {
      throw new Error('附件与确认页不一致')
    }
  }
  const unknown = <T,>(): Field<T> => ({ value: null, source: 'unknown' })
  const heaven = options.heaven
  const homeHerbs = cleanSharedHomeHerbs(options.homeHerbs)
  if (heaven !== undefined && !isHeavenStamp(heaven)) throw new Error('天时格式无效')
  // V2-32：体态只带关键点、视角、时间与感觉；这里再清洗一次，绝不把图片字节或指标带出手机。
  let postures: PostureRecord[] | undefined
  if (state.posture) {
    try { postures = sanitizeStudentPostures([state.posture], { student: state.student, teacher: state.teacher }) }
    catch (cause) { throw new Error('体态记录格式不对：' + (cause instanceof Error ? cause.message : '请重拍。')) }
  }
  const encounter: Encounter = {
    id: state.encounterId,
    version: 1,
    kind: state.kind,
    student: state.student,
    teacher: state.teacher,
    createdAt: state.createdAt,
    ...(heaven ? { heaven: { ...heaven } } : {}),
    profile: structuredClone(profile),
    intake: {
      chiefComplaint: structuredClone(state.fields.chiefComplaint),
      presentIllness: structuredClone(state.fields.presentIllness),
      history: structuredClone(state.fields.history),
      medsAllergies: structuredClone(state.fields.medsAllergies),
      attachments: state.attachments.map(ref => ({ ...ref })),
      ...(state.tongues ? {tongues:state.tongues.map(parseTongueAbstract)} : {}),
    },
    fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
    judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
    plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
  }
  const pkg: ConsultPackage = {
    encounter,
    history: history.map(candidate => candidate.eventJson),
    attachments: attachments.map(item => ({ ref: { ...item.ref }, data: item.data })),
    ...(heaven ? { heaven: { ...heaven } } : {}),
    ...(trend ? { trend } : {}),
    ...(postures && postures.length > 0 ? { postures } : {}),
    ...(homeHerbs ? { homeHerbs } : {}),
  }
  // M1-22：家人代管问诊时带上代管人公钥与代管证明，只走传输元数据，不改病历 schema。
  if (options.manager !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(options.manager)) throw new Error('代管人公钥格式无效')
    if (options.managerProof === undefined) throw new Error('缺少代管证明，不能替家人问诊')
    pkg.manager = options.manager
    pkg.managerProof = structuredClone(options.managerProof)
  }
  // V2-10：只带计数与智能体那一句；本人感受不进问诊包。
  if (options.observation !== undefined) {
    const observation = parsePeriodObservation(options.observation)
    if (!observation) throw new Error('观察周期数据无效')
    pkg.observation = observation
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
  options: { manager?: string; managerProof?: ConsultPackage['managerProof']; heaven?: ConsultPackage['heaven']; observation?: ConsultPackage['observation']; homeHerbs?: ConsultPackage['homeHerbs'] } = {},
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
  if(state.tongues)state.tongues.forEach(parseTongueAbstract)
  if (state.posture) sanitizeStudentPostures([state.posture], { student: state.student, teacher: state.teacher })
  await store.put(INTAKE_COLLECTIONS.draft, state.encounterId, state)
}

function isSession(value: unknown): value is IntakeSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const session = value as IntakeSession
  if(session.tongues!==undefined) {
    if(!Array.isArray(session.tongues)||session.tongues.length>4)return false
    try {session.tongues.forEach(parseTongueAbstract)} catch {return false}
  }
  if (session.posture !== undefined) {
    try { sanitizeStudentPostures([session.posture], { student: session.student, teacher: session.teacher }) } catch { return false }
  }
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
