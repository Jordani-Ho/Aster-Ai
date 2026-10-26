import templateText from '../../../../prompts/student/nudge.md?raw'
import type { LocalStore, StoreValue } from '../store'
import type { Identity } from '../identity'
import { createRunner } from '../agent/runner'
import { agentKey, defineTask } from '../agent/tasks'
import { dailyAdherence } from '../adherence'
import { listAppointments, type Appointment } from '../appointments'
import { listCheckins, type Assignment, type Checkin } from '../homework'
import { addDays, checkinDay, effectiveDay, localDay, parseDay, schedule } from '../homework/schedule'
import { listReceivedRecords } from '../inbox'
import { listTongueDays } from '../tongue'
import { loadCachedRevisitDays } from '../storefront'

export const NUDGE_COLLECTION = 'student-nudges'
export const BANNED_NUDGE_WORDS = ['诊断', '病', '癌', '高血压', '糖尿', '心脏', '抑郁', '焦虑', '严重', '后果', '致命', '死亡', '危险', '羞', '懒', '必须服药'] as const
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
const DAY_MS = 86_400_000
const REPEAT_MS = 4 * 60 * 60_000
const types = ['homework', 'mirror', 'revisit', 'appointment', 'sleep'] as const
export type NudgeKind = typeof types[number]
export type NudgeStage = 'first' | 'again' | 'daily' | 'urgent'
export interface NudgeEvent { id: string; kind: NudgeKind; target: string; episode: string; stage: NudgeStage; at: string; text: string; actedAt: string | null }
export interface NudgeVisit { id: string; at: string; kind: 'remote_async' | 'remote_live' | 'in_person'; next: string | null }
export interface NudgeInputs {
  now: Date
  assignments: Assignment[]
  checkins: Checkin[]
  mirrorDays: string[]
  mirrorStartDay: string | null
  appointments: Appointment[]
  visits: NudgeVisit[]
  routine: { wake: string; sleep: string } | null
  revisitDays: number | null
}
export interface NudgeCandidate { kind: NudgeKind; target: string; episode: string; stage: NudgeStage; slots: Record<string, string | number> }

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function validDay(value: unknown): value is string { try { return typeof value === 'string' && localDay(parseDay(value)) === value } catch { return false } }
function dayDistance(from: string, to: string): number { return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS) }
function clock(value: string): number { return Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) }
function validInterval(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 3650 }
function banned(text: string): boolean { return BANNED_NUDGE_WORDS.some(word => text.includes(word)) }

export function validateNudgeTemplates(value: unknown): Record<string, string> {
  if (!object(value)) throw Error('督促话术格式无效')
  const required = [
    'homework.first', 'homework.again', 'homework.daily', 'homework.daily_progress',
    'mirror.first', 'mirror.again', 'mirror.daily', 'revisit.first', 'revisit.again', 'revisit.daily',
    'appointment.urgent', 'sleep.first',
  ]
  if (Object.keys(value).length !== required.length || required.some(key => typeof value[key] !== 'string' || !value[key])) throw Error('督促话术缺项')
  for (const [key, line] of Object.entries(value)) {
    if (!required.includes(key) || typeof line !== 'string' || line.length > 180 || banned(line) || /[\u0000-\u001f\u007f]/.test(line)) throw Error('督促话术含禁用词或无效字符')
  }
  return value as Record<string, string>
}
const templateBlock = /```json\s*([\s\S]*?)```/.exec(templateText)
if (!templateBlock) throw Error('督促话术缺少 JSON 模板')
export const NUDGE_TEMPLATES = validateNudgeTemplates(JSON.parse(templateBlock[1]))

/** 数据不足或数据槽含危险词时整句不发；不自行补数字或改写老师标题。 */
export function renderNudge(candidate: NudgeCandidate): string | null {
  const key = candidate.kind + '.' + (candidate.kind === 'homework' && candidate.stage === 'daily' &&
    ['thisDone', 'thisPlanned', 'lastDone', 'lastPlanned'].every(name => candidate.slots[name] !== undefined) ? 'daily_progress' : candidate.stage)
  const template = NUDGE_TEMPLATES[key]
  if (!template) return null
  let missing = false
  const text = template.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    const value = candidate.slots[name]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
    if (typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f{}]/.test(value) && !banned(value)) return value
    missing = true
    return ''
  })
  return missing || banned(text) || /\{[^}]+\}/.test(text) ? null : text
}

export function assertNudgeInputs(input: NudgeInputs): void {
  if (!(input.now instanceof Date) || !Number.isFinite(+input.now) || !Array.isArray(input.assignments) || !Array.isArray(input.checkins)
    || !Array.isArray(input.mirrorDays) || !input.mirrorDays.every(validDay) || (input.mirrorStartDay !== null && !validDay(input.mirrorStartDay)) || !Array.isArray(input.appointments)
    || !Array.isArray(input.visits) || (input.routine !== null && (!object(input.routine) || !CLOCK.test(String(input.routine.wake)) || !CLOCK.test(String(input.routine.sleep))))
    || (input.revisitDays !== null && !validInterval(input.revisitDays))) throw Error('督促材料无效')
  if (input.assignments.some(item => {
    if (!object(item) || !object(item.homework) || typeof item.homework.id !== 'string' || !item.homework.id
      || typeof item.homework.title !== 'string' || !item.homework.title || !validDay(item.startsOn)) return true
    try { schedule([item.homework], item.startsOn, 0); return false } catch { return true }
  })) throw Error('作业材料无效')
  if (input.checkins.some(item => !object(item) || typeof item.homeworkId !== 'string' || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)))) throw Error('打卡材料无效')
  if (input.appointments.some(item => !object(item) || typeof item.offerId !== 'string' || !item.offerId
    || !['offered', 'requested', 'accepted', 'confirmed', 'declined', 'expired', 'done', 'no_show', 'cancelled'].includes(String(item.status))
    || !Number.isSafeInteger(item.expiresAt) || typeof item.slotStart !== 'string' || !Number.isFinite(Date.parse(item.slotStart))
    || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)))) throw Error('邀约材料无效')
  if (input.visits.some(item => !object(item) || typeof item.id !== 'string' || !['remote_async', 'remote_live', 'in_person'].includes(item.kind) || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || (item.next !== null && typeof item.next !== 'string'))) throw Error('病历材料无效')
}

function quietWindow(now: Date, routine: NudgeInputs['routine']): { quiet: boolean; episode: string } {
  if (!routine || routine.sleep === routine.wake) return { quiet: false, episode: '' }
  const minutes = now.getHours() * 60 + now.getMinutes(), sleep = clock(routine.sleep), wake = clock(routine.wake)
  const quiet = sleep > wake ? minutes >= sleep || minutes < wake : minutes >= sleep && minutes < wake
  const episode = minutes < wake && sleep > wake ? localDay(addDays(now, -1)) : localDay(now)
  return { quiet, episode }
}

function stageFor(now: Date, episode: string, prior: readonly NudgeEvent[], earliest: Date): NudgeStage | null {
  const today = localDay(now), elapsed = dayDistance(episode, today)
  if (elapsed < 0 || +now < +earliest) return null
  const relevant = prior.filter(row => row.episode === episode && row.actedAt === null)
  const first = relevant.find(row => row.stage === 'first')
  if (!first) return 'first'
  if (localDay(new Date(first.at)) === today) {
    return !relevant.some(row => row.stage === 'again') && now.getHours() >= 19 && +now - Date.parse(first.at) >= REPEAT_MS ? 'again' : null
  }
  return relevant.some(row => row.stage === 'daily' && localDay(new Date(row.at)) === today) ? null : 'daily'
}

function progress(input: NudgeInputs): Record<string, number> | null {
  const today = effectiveDay(input.now)
  const from = localDay(addDays(parseDay(today), -13))
  const days = dailyAdherence(input.assignments, input.checkins, from, today)
  const total = (rows: typeof days) => rows.reduce((acc, row) => ({ done: acc.done + row.done, planned: acc.planned + row.scheduled }), { done: 0, planned: 0 })
  const last = total(days.slice(0, 7)), current = total(days.slice(7))
  return last.planned && current.planned ? { thisDone: current.done, thisPlanned: current.planned, lastDone: last.done, lastPlanned: last.planned } : null
}

function planInterval(text: string | null): number | null {
  const match = text?.match(/(?:^|[，。；\s])(?:建议)?([1-9]\d{0,3})天后复诊(?:$|[，。；\s])/) ?? null
  const days = match ? Number(match[1]) : null
  return validInterval(days) ? days : null
}

function candidate(kind: NudgeKind, target: string, episode: string, stage: NudgeStage, slots: NudgeCandidate['slots']): NudgeCandidate {
  return { kind, target, episode, stage, slots }
}

/** 纯规则；没有模型，也不判断症状。所有时刻均按设备本地日历与用户作息计算。 */
export function chooseNudges(input: NudgeInputs, logs: readonly NudgeEvent[]): NudgeCandidate[] {
  assertNudgeInputs(input)
  const now = input.now, today = localDay(now), quiet = quietWindow(now, input.routine)
  if (quiet.quiet) return logs.some(row => row.kind === 'sleep' && row.episode === quiet.episode)
    ? [] : [candidate('sleep', 'self', quiet.episode, 'first', {})]
  const result: NudgeCandidate[] = []
  for (const offer of input.appointments) {
    const minutes = Math.ceil((offer.expiresAt - +now) / 60_000)
    if (offer.status === 'offered' && minutes > 0 && minutes <= 30 && !logs.some(row => row.kind === 'appointment' && row.target === offer.offerId))
      result.push(candidate('appointment', offer.offerId, offer.offerId, 'urgent', { minutes }))
  }
  for (const assignment of input.assignments) {
    const { homework, startsOn } = assignment
    if (homework.schedule.kind === 'habit') continue
    const completed = input.checkins.filter(row => row.homeworkId === homework.id && Date.parse(row.at) <= +now)
      .map(row => checkinDay(new Date(row.at))).sort().at(-1) ?? ''
    const from = homework.schedule.kind === 'once' ? homework.schedule.date : localDay(addDays(now, -13))
    const windowDays = homework.schedule.kind === 'once' ? 1 : 14
    let due: { at: Date; day: string }[] = []
    try { due = schedule([homework], startsOn, windowDays, from).filter(row => +row.at + 10 * 60_000 <= +now && localDay(row.at) > completed).map(row => ({ at: row.at, day: localDay(row.at) })) }
    catch { continue }
    if (!due.length) continue
    const first = due[0], episode = completed ? localDay(addDays(parseDay(completed), 1)) : startsOn
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), first.at.getHours(), first.at.getMinutes() + 10)
    const earliest = first.day === today ? new Date(+first.at + 10 * 60_000) : at
    const prior = logs.filter(row => row.kind === 'homework' && row.target === homework.id)
    const stage = stageFor(now, episode, prior, earliest)
    if (!stage) continue
    result.push(candidate('homework', homework.id, episode, stage, { title: homework.title, ...(stage === 'daily' ? progress(input) ?? {} : {}) }))
  }
  const lastMirror = input.mirrorDays.filter(day => day <= today).sort().at(-1) ?? input.mirrorStartDay
  if (lastMirror && !input.mirrorDays.includes(today)) {
    const dueDay = localDay(addDays(parseDay(lastMirror), 3)), days = dayDistance(lastMirror, today)
    const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0)
    const stage = days >= 3 ? stageFor(now, dueDay, logs.filter(row => row.kind === 'mirror'), earliest) : null
    if (stage) result.push(candidate('mirror', 'self', dueDay, stage, { days }))
  }
  const latest = input.visits.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  const lastInPerson = input.visits.filter(row => row.kind === 'in_person').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  const planDays = latest ? planInterval(latest.next) : null
  const anchor = planDays ? latest : lastInPerson
  const interval = planDays ?? input.revisitDays
  if (anchor && interval && !input.appointments.some(row => ['offered', 'requested', 'accepted', 'confirmed'].includes(row.status) && Date.parse(row.slotStart) > +now)) {
    const fromDay = localDay(new Date(anchor.at)), dueDay = localDay(addDays(parseDay(fromDay), interval))
    const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0)
    const stage = stageFor(now, dueDay, logs.filter(row => row.kind === 'revisit' && row.target === anchor.id), earliest)
    if (stage) result.push(candidate('revisit', anchor.id, dueDay, stage, { days: dayDistance(fromDay, today), interval }))
  }
  return result
}

function isNudgeEvent(value: unknown): value is NudgeEvent {
  return object(value) && typeof value.id === 'string' && types.includes(value.kind as NudgeKind)
    && typeof value.target === 'string' && typeof value.episode === 'string' && ['first', 'again', 'daily', 'urgent'].includes(String(value.stage))
    && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) && typeof value.text === 'string'
    && (value.actedAt === null || typeof value.actedAt === 'string' && Number.isFinite(Date.parse(value.actedAt)))
}
export async function listNudges(store: Pick<LocalStore, 'list'>): Promise<NudgeEvent[]> {
  const events: NudgeEvent[] = []
  for (const row of await store.list(NUDGE_COLLECTION)) if (isNudgeEvent(row.value)) events.push(row.value)
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/** 行动以本机事实为准；睡眠无法实测，保留“未知”，不猜学生已经睡了。 */
export async function reconcileNudges(store: Pick<LocalStore, 'list' | 'put'>, input: NudgeInputs): Promise<void> {
  for (const row of await listNudges(store)) {
    if (row.actedAt) continue
    const at = Date.parse(row.at)
    const acted = row.kind === 'homework' ? input.checkins.some(item => item.homeworkId === row.target && Date.parse(item.at) > at)
      : row.kind === 'mirror' ? input.mirrorDays.some(day => day >= localDay(new Date(at)))
        : row.kind === 'appointment' ? input.appointments.some(item => item.offerId === row.target && ['accepted', 'confirmed', 'declined'].includes(item.status))
          : row.kind === 'revisit' ? input.appointments.some(item => Date.parse(item.createdAt) > at && ['requested', 'accepted', 'confirmed'].includes(item.status)) : false
    if (acted) await store.put(NUDGE_COLLECTION, row.id, { ...row, actedAt: input.now.toISOString() } as unknown as StoreValue)
  }
}

export async function collectNudgeInputs(store: LocalStore, settingsStore: LocalStore, identity: Identity, teacher: string | null, now = new Date(), mirrorStartDay: string | null = null): Promise<NudgeInputs> {
  const [assignmentRows, checkins, mirrorDays, appointments, records, routineRaw, revisitDays] = await Promise.all([
    store.list('homework'), listCheckins(store), listTongueDays(store), listAppointments(store), listReceivedRecords(store, identity), store.get('settings', 'agent-routine'),
    teacher ? loadCachedRevisitDays(settingsStore, teacher) : Promise.resolve(null),
  ])
  const routine = object(routineRaw) && typeof routineRaw.wake === 'string' && typeof routineRaw.sleep === 'string' && CLOCK.test(routineRaw.wake) && CLOCK.test(routineRaw.sleep)
    ? { wake: routineRaw.wake, sleep: routineRaw.sleep } : null
  const visits = records.filter(row => !teacher || row.teacher === teacher).map(row => ({
    id: row.encounter.id, at: row.encounter.createdAt, kind: row.encounter.kind, next: row.encounter.outcome?.next.value ?? null,
  }))
  const input: NudgeInputs = { now, assignments: assignmentRows.map(row => row.value as unknown as Assignment), checkins, mirrorDays, mirrorStartDay, appointments, visits, routine, revisitDays }
  assertNudgeInputs(input)
  return input
}

/** 每次打开、回前台或跨钟点时补做；页面关闭期间不假装能在后台推理。 */
export async function runStudentNudges(options: { store: LocalStore; settingsStore: LocalStore; identity: Identity; teacher: string | null; now?: Date; notifySelf?: () => Promise<void> }): Promise<NudgeEvent[]> {
  const { store, settingsStore, identity, teacher } = options
  const now = options.now ?? new Date()
  if (!(now instanceof Date) || !Number.isFinite(+now)) throw Error('督促时间无效')
  const started = await store.get('student-nudge-meta', 'mirror-start')
  const mirrorStartDay = validDay(started) && started <= localDay(now) ? started : localDay(now)
  if (started !== mirrorStartDay) await store.put('student-nudge-meta', 'mirror-start', mirrorStartDay)
  const input = await collectNudgeInputs(store, settingsStore, identity, teacher, now, mirrorStartDay)
  await reconcileNudges(store, input)
  const logs = await listNudges(store), candidates = chooseNudges(input, logs)
  let sent = 0
  for (const item of candidates) {
    const text = renderNudge(item)
    if (!text) continue
    const targetId = await agentKey([item.kind, item.target, item.episode])
    const task = defineTask({
      id: 'student-nudge', side: 'student', trigger: { kind: 'open' }, confirm: 'template',
      gather: async () => item,
      inputKey: async () => item.stage,
      run: async () => ({ kind: item.kind, target: item.target, episode: item.episode, stage: item.stage, text }),
      deliver: async result => {
        const id = await agentKey([result.kind, result.target, result.episode, result.stage, localDay(input.now)])
        await store.put(NUDGE_COLLECTION, id, { id, ...result, at: input.now.toISOString(), actedAt: null } as unknown as StoreValue)
      },
    })
    const before = logs.some(row => row.kind === item.kind && row.target === item.target && row.episode === item.episode && row.stage === item.stage && localDay(new Date(row.at)) === localDay(input.now))
    const run = await createRunner({ store, side: 'student', maxTokens: 1000 }).run(task, { targetId, now: input.now })
    if (run.status === 'delivered') await store.delete('agent-runs', run.key).catch(() => {})
    if (!before) sent += 1
  }
  if (sent && options.notifySelf) await options.notifySelf().catch(() => {})
  return listNudges(store)
}
