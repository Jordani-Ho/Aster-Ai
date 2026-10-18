import type { Identity } from '../identity'
import type { LocalStore } from '../store'
import type { Message, Envelope } from '../transport'
import type { ReceivedRecord, SendEnvelope } from '../inbox'
import { verifySignedEncounter } from '../record/sign'
import { validateVideoRef, readVideoCipher, deleteVideoCipher, loadVideo, uploadVideo, type PracticeVideoRef } from './index'

export const REVIEW_COLLECTION = 'practice-reviews'
export const OUTGOING_COLLECTION = 'practice-outgoing'
export interface PracticeSubmission { id: string; encounterId: string; homework: string; original: PracticeVideoRef; practice: PracticeVideoRef; studentLabel?: string; homeworkTitle?: string }
export interface PracticeReview extends PracticeSubmission { student: string; teacher: string; receivedAt: string }
export interface PracticeOutgoing extends PracticeSubmission { teacher: string; sent: boolean; reply?: string; at: string }
const json = (value: unknown) => JSON.parse(JSON.stringify(value))
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)

export async function sendPractice(record: ReceivedRecord, homework: string, practice: PracticeVideoRef, identity: Identity, fileIdentity: Identity, store: LocalStore, base: string, send: SendEnvelope) {
  const encounter = verifySignedEncounter(record.event, { teacher: record.teacher, student: identity.publicKey })
  const original = encounter.plan.homework.find(hw => hw.id === homework)?.video
  if (!original) throw Error('这条作业还没有对照视频')
  validateVideoRef(original, { teacher: record.teacher, student: identity.publicKey, homework, role: 'original' })
  validateVideoRef(practice, { ...original.context, role: 'practice' })
  const prior = (await store.list(OUTGOING_COLLECTION)).map(row => row.value as unknown as PracticeOutgoing).find(row => row.practice.sha256 === practice.sha256)
  if (prior?.sent) return prior.id
  const payload: PracticeSubmission = { id: prior?.id ?? crypto.randomUUID(), encounterId: encounter.id, homework, original, practice, studentLabel: encounter.profile.alias.value?.slice(0, 80) || '学生', homeworkTitle: encounter.plan.homework.find(hw => hw.id === homework)!.title.slice(0, 120) }
  await store.put(OUTGOING_COLLECTION, payload.id, json({ ...prior, ...payload, teacher: record.teacher, sent: false, at: prior?.at ?? new Date().toISOString() }))
  const originalPlain = await loadVideo(store, base, fileIdentity, original, original.context)
  originalPlain.fill(0)
  // Re-upload the same validated ciphertext if needed; never re-encrypt with an old IV.
  for (const ref of [original, practice]) {
    const bytes = await readVideoCipher(store, ref.sha256)
    if (!(bytes instanceof Uint8Array)) throw Error('视频请从备份文件恢复，或请老师重发')
    await uploadVideo(base, fileIdentity, ref, bytes)
  }
  await send(record.teacher, { type: 'practice.submit', version: 1, payload: json(payload) })
  const current = await store.get(OUTGOING_COLLECTION, payload.id) as unknown as PracticeOutgoing
  await store.put(OUTGOING_COLLECTION, payload.id, json({ ...current, sent: true }))
  await store.put('settings', 'video-weekly-reminder', new Date().toISOString())
  return payload.id
}

async function destroyReview(store: LocalStore, review: PracticeReview) {
  for (const ref of [review.original, review.practice]) await deleteVideoCipher(store, ref.sha256)
  await store.delete(REVIEW_COLLECTION, review.id)
}
export async function listPracticeReviews(store: LocalStore) {
  const result: PracticeReview[] = []
  for (const row of await store.list(REVIEW_COLLECTION)) {
    const review = row.value as unknown as PracticeReview
    if (await store.get('practice-reviewed', review.id)) await destroyReview(store, review)
    else result.push(review)
  }
  return result.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
}
export async function receivePracticeMessage(identity: Identity, store: LocalStore, message: Message) {
  const { type, payload } = message.envelope
  if (type !== 'practice.submit' && type !== 'practice.reply') return
  try {
    if (!payload || typeof payload !== 'object' || JSON.stringify(payload).length > 12000) return
    const p = payload as PracticeSubmission & { text?: string }
    if (!uuid(p.id)) return
    if (type === 'practice.reply') {
      const outgoing = await store.get(OUTGOING_COLLECTION, p.id) as unknown as PracticeOutgoing | undefined
      const teachers = await store.get('settings', 'teachers')
      if (!outgoing || outgoing.teacher !== message.sender || !Array.isArray(teachers) || !teachers.includes(message.sender) || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 2000 || outgoing.reply) return
      await store.put(OUTGOING_COLLECTION, p.id, json({ ...outgoing, reply: p.text }))
      return
    }
    if (!/^[0-9a-f]{32}$/.test(p.encounterId) || typeof p.homework !== 'string') return
    validateVideoRef(p.original, { teacher: identity.publicKey, student: message.sender, homework: p.homework, role: 'original' })
    validateVideoRef(p.practice, { teacher: identity.publicKey, student: message.sender, homework: p.homework, role: 'practice' })
    const known = (await store.list('signed-encounters')).some(row => {
      const index = row.value as { student?: string; encounterId?: string }
      return index.student === message.sender && index.encounterId === p.encounterId
    })
    if (!known || await store.get('practice-reviewed', p.id) || await store.get(REVIEW_COLLECTION, p.id)) return
    const studentLabel = typeof p.studentLabel === 'string' ? p.studentLabel.slice(0, 80) : '学生'
    const homeworkTitle = typeof p.homeworkTitle === 'string' ? p.homeworkTitle.slice(0, 120) : '练习'
    await store.put(REVIEW_COLLECTION, p.id, json({ id: p.id, encounterId: p.encounterId, homework: p.homework, original: p.original, practice: p.practice, studentLabel, homeworkTitle, student: message.sender, teacher: identity.publicKey, receivedAt: new Date().toISOString() } satisfies PracticeReview))
  } catch { /* Invalid peer payloads are discarded, without logging contents. */ }
}
export async function replyToPractice(identity: Identity, store: LocalStore, id: string, text: string, send: (recipient: string, envelope: Envelope) => Promise<unknown>) {
  const review = await store.get(REVIEW_COLLECTION, id) as unknown as PracticeReview | undefined
  if (!review || review.teacher !== identity.publicKey || !text.trim() || text.length > 2000) throw Error('请写一句回复')
  await send(review.student, { type: 'practice.reply', version: 1, payload: { id, text: text.trim() } })
  await store.put('practice-reviewed', id, { at: new Date().toISOString() })
  await destroyReview(store, review)
}
