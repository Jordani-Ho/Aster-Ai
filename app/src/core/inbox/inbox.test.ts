import { afterEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { IDBFactory } from 'fake-indexeddb'
import { type Event } from 'nostr-tools/pure'
import type { Socket } from '../transport'
import { validSignature } from '../transport/crypto'
import { openStore, type LocalStore, type StoreValue } from '../store'
import { createIdentity, type Identity } from '../identity'
import type { LlmClient } from '../llm'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import template from '../../../../domain/tcm/templates/default.json'
import type { ConsultPackage, Encounter, Homework } from '../record/types'
import { signEncounter, type SignedEncounterEvent } from '../record/sign'
import { draftEncounter } from '../drafting'
import {
  addPhoto,
  buildConsultPackage,
  emptyProfile,
  markReviewed,
  organizeSession,
  saveDraft,
  skipFocus,
  startSession,
  type IntakeSession,
} from '../intake/session'
import { localDay } from '../homework/schedule'
import {
  addTeacher,
  assertConsultReady,
  completeConsultSigning,
  consultEnvelope,
  consultReadiness,
  draftPackage,
  flushIntakeOutbox,
  groupReceivedRecords,
  listConsults,
  listReceivedRecords,
  loadTeachers,
  removeTeacher,
  restartIntakeAfterEmergency,
  sha256Hex,
  toBase64,
} from './index'
import { createWiring } from '../wiring'
import { startInPersonEncounter, recordIntakeField } from '../record/in-person'

// 只用合成身份、合成病历与内存中继；不连真实 relay/gateway，不发真实推送。
const phrase = 'leader monkey parrot ring guide accident before fence cannon height naive bean'
const teacherId = createIdentity(phrase, 'english')
const studentId = createIdentity(phrase, 'english', 1)
const teacherPub = teacherId.publicKey
const studentPub = studentId.publicKey
const closers: (() => void)[] = []
// 自己的轮询：indexeddb 与内存中继都是异步的，等到条件成立再读，避免读到中间态。
async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 10000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await check()
    if (result || Date.now() >= deadline) return result as NonNullable<T>
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
vi.setConfig({ testTimeout: 30000 })
afterEach(() => { closers.splice(0).reverse().forEach(close => close()) })

// 与 transport.test.ts / ledger/sync.test.ts 一致的带鉴权内存中继。
class MemoryRelay {
  events = new Map<string, Event>();
  clients = new Set<MemorySocket>();
  members = new Set([teacherPub, studentPub])
  socket = (): Socket => new MemorySocket(this)
}
class MemorySocket implements Socket {
  readyState = 0; onopen: Socket['onopen'] = null; onclose: Socket['onclose'] = null
  onerror: Socket['onerror'] = null; onmessage: Socket['onmessage'] = null
  challenge = crypto.randomUUID(); owner = ''; sub = false
  constructor(private relay: MemoryRelay) {
    relay.clients.add(this)
    queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); this.emit(['AUTH', this.challenge]) })
  }
  emit(value: unknown) { queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }) }) }
  send(data: string) {
    const [cmd, first] = JSON.parse(data)
    if (cmd === 'AUTH') {
      const event = first as Event, tags = Object.fromEntries(event.tags)
      const valid = validSignature(event) && event.kind === 22242 && this.relay.members.has(event.pubkey)
        && tags.challenge === this.challenge && tags.relay === 'ws://localhost/'
      if (valid) this.owner = event.pubkey
      this.emit(['OK', event.id, valid, valid ? '' : 'restricted: member required']); return
    }
    if (!this.owner) { this.emit(cmd === 'REQ' ? ['CLOSED', first, 'auth-required:'] : ['OK', first.id, false, 'auth-required:']); return }
    if (cmd === 'REQ') {
      this.sub = true
      for (const event of this.relay.events.values()) if (event.tags.some(tag => tag[0] === 'p' && tag[1] === this.owner)) this.emit(['EVENT', 'inbox', event])
      this.emit(['EOSE', 'inbox']); return
    }
    if (cmd === 'EVENT') {
      const event = first as Event
      if (!validSignature(event)) { this.emit(['OK', event.id, false, 'invalid:']); return }
      if (!this.relay.events.has(event.id)) {
        this.relay.events.set(event.id, JSON.parse(JSON.stringify(event)))
        for (const client of this.relay.clients) {
          if (client.sub && event.tags.some(tag => tag[0] === 'p' && tag[1] === client.owner)) client.emit(['EVENT', 'inbox', event])
        }
      }
      this.emit(['OK', event.id, true, ''])
    }
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.relay.clients.delete(this); this.onclose?.({}) }
}

async function testStore(identity: Identity): Promise<LocalStore> {
  const store = await openStore(identity, { name: crypto.randomUUID(), factory: new IDBFactory() })
  closers.push(() => store.close())
  return store
}

async function openNode(identity: Identity, relay: MemoryRelay, notifier?: (pubkey: string) => Promise<void>) {
  const store = await testStore(identity)
  const status = { value: '' }
  const wiring = createWiring({
    identity, store, relays: ['ws://localhost/'], socket: relay.socket,
    notifier, onStatus: value => { status.value = value },
  })
  closers.push(() => { void wiring.close() })
  wiring.start()
  return { wiring, store, status }
}

async function nodes(options: { studentNotifier?: (pubkey: string) => Promise<void> } = {}) {
  const relay = new MemoryRelay()
  const teacherNode = await openNode(teacherId, relay)
  const studentNode = await openNode(studentId, relay, options.studentNotifier)
  await waitFor(() => teacherNode.status.value === 'ready' && studentNode.status.value === 'ready')
  return { relay, teacher: teacherNode.wiring, student: studentNode.wiring, teacherStore: teacherNode.store, studentStore: studentNode.store }
}

// 合成照片：任意字节 + 真实 sha256，模拟 M1-09 处理后的结果。
async function syntheticPhotos(count: number) {
  const photos: { ref: { id: string; type: 'photo'; sha256: string; bytes: number }; data: Uint8Array }[] = []
  for (let index = 0; index < count; index += 1) {
    const data = new Uint8Array([index + 1, 2, 3, index + 4, 5, 6])
    photos.push({
      ref: { id: (index + 1).toString(16).padStart(32, '0'), type: 'photo', sha256: await sha256Hex(data), bytes: data.length },
      data,
    })
  }
  return photos
}

// 走完 M1-09 采集到确认页，生成一份带指定照片的合法问诊包。
async function syntheticPackage(photoCount: number): Promise<ConsultPackage> {
  let state: IntakeSession = startSession({
    student: studentPub, teacher: teacherPub, template: template as TeacherTemplate,
    now: new Date('2026-10-17T08:00:00.000Z'), id: 'a'.repeat(32),
  })
  state = await organizeSession(state, null)
  for (let guard = 0; guard < 12 && state.phase === 'collecting'; guard += 1) {
    for (const question of [...state.questions]) state = skipFocus(state, question.focus)
    state = await organizeSession(state, null)
  }
  state = markReviewed(state)
  const photos = await syntheticPhotos(photoCount)
  for (const photo of photos) state = addPhoto(state, photo)
  return buildConsultPackage(state, emptyProfile(), [], photos)
}

function fakeLlm(): LlmClient {
  // 起草模块要求模型按 Field 形状返回（{ value }），来源由模块强制为 ai_draft。
  const reply = {
    fourExams: { look: { value: '舌淡红' }, listenSmell: { value: '语声正常' }, ask: { value: '睡眠差' }, pulse: { value: '脉细' } },
    judgment: { symptomSummary: { value: '睡眠差' }, pattern: { value: '心脾两虚' }, mechanism: { value: '气血不足' }, rationale: { value: '舌淡脉细' } },
    plan: {
      principle: { value: '健脾养心' },
      prescription: { value: { items: [{ herb: '合成药', dose: '3g' }], days: 3 } },
      homework: [{ title: '按揉太渊穴', detail: '每天两次，每次三分钟', schedule: { kind: 'daily', time: '08:00' } }],
      advice: { value: '规律作息' },
    },
  }
  return { complete: vi.fn().mockResolvedValue(JSON.stringify(reply)), stream: vi.fn() }
}

// 合成一份面诊病历并签名：用于学生端“我的老师”白名单测试。
function signedRecordFor(signer: Identity, options: { encounterId?: string; homework?: boolean } = {}): SignedEncounterEvent {
  let encounter: Encounter = startInPersonEncounter({
    teacher: signer.publicKey, student: studentPub,
    id: options.encounterId ?? 'd'.repeat(32), now: new Date('2026-10-17T09:00:00.000Z'),
  })
  encounter = recordIntakeField(encounter, 'chiefComplaint', '合成主诉，只用合成数据').encounter
  if (options.homework) {
    encounter = {
      ...encounter,
      plan: {
        ...encounter.plan,
        homework: [{ id: 'hw-synthetic', title: '合成作业', detail: '合成说明', schedule: { kind: 'daily', time: '08:00' }, source: 'teacher' }],
      },
    }
  }
  return signEncounter(encounter, signer.privateKey)
}

function acceptDraft(draft: Encounter): Encounter {
  const final = structuredClone(draft)
  for (const key of ['look', 'listenSmell', 'ask', 'pulse'] as const) {
    if (final.fourExams[key].source === 'ai_draft') final.fourExams[key] = { ...final.fourExams[key], source: 'teacher', note: 'ai_accepted' }
  }
  for (const key of ['symptomSummary', 'pattern', 'mechanism', 'rationale'] as const) {
    if (final.judgment[key].source === 'ai_draft') final.judgment[key] = { ...final.judgment[key], source: 'teacher', note: 'ai_accepted' }
  }
  const plan = final.plan as unknown as Record<string, { value: unknown; source: string; note?: string }>
  for (const key of ['principle', 'prescription', 'advice']) {
    if (plan[key].source === 'ai_draft') plan[key] = { ...plan[key], source: 'teacher', note: 'ai_accepted' }
  }
  final.plan.homework = final.plan.homework.map(item => item.source === 'ai_draft' ? { ...item, source: 'teacher' as const, note: 'ai_accepted' } : item)
  return final
}

it('1 两个 createTransport 加内存中继：学生发 2 张照片的问诊包，老师问诊箱出现这份问诊且照片到齐', async () => {
  const { student, teacherStore } = await nodes()
  const pkg = await syntheticPackage(2)
  // 附带一份合法历史病历和一份伪造的，老师端只接受验签通过、签名人为本人的。
  const validHistory = signEncounter(
    { ...pkg.encounter, id: 'c'.repeat(32), createdAt: '2026-10-01T00:00:00.000Z' },
    teacherId.privateKey,
  )
  const forgedHistory = { ...validHistory, content: validHistory.content.replace('"version":1', '"version":9') }
  pkg.history = [JSON.stringify(validHistory), JSON.stringify(forgedHistory)]
  await student.sendConsult(pkg)
  const consults = await waitFor(async () => {
    const rows = await listConsults(teacherStore)
    return rows.length === 1 ? rows : null
  })
  expect(consults[0].encounter.id).toBe(pkg.encounter.id)
  expect(consults[0].sender).toBe(studentPub)
  expect(consults[0].history).toHaveLength(1)
  expect(consults[0].droppedHistory).toBe(1)
  const readiness = await waitFor(async () => {
    const status = await consultReadiness(teacherStore, pkg.encounter.id)
    return status.ready ? status : null
  })
  expect(readiness).toMatchObject({ total: 2, arrived: 2, ready: true })
})

it('2 老师起草、签字、填扣费 3：学生病历页、作业、账本余额与对账码都对上', async () => {
  const { teacher, student, teacherStore, studentStore } = await nodes()
  await teacher.ledger.open(teacherPub, studentPub)
  await student.ledger.open(teacherPub, studentPub)
  await teacher.ledger.requestSync()
  await student.ledger.requestSync()

  const pkg = await syntheticPackage(2)
  await student.sendConsult(pkg)
  const consult = await waitFor(async () => {
    const rows = await listConsults(teacherStore)
    if (rows.length !== 1) return null
    const status = await consultReadiness(teacherStore, rows[0].encounter.id)
    return status.ready ? rows[0] : null
  })
  expect(consult.encounter.id).toBe(pkg.encounter.id)
  await assertConsultReady(teacherStore, consult.encounter.id)

  const draft = await draftEncounter(draftPackage(consult), template as TeacherTemplate, [], fakeLlm(), { level: 'prescription' })
  const final = acceptDraft(draft)
  await completeConsultSigning({
    identity: teacherId, store: teacherStore, consult, draft, final,
    send: teacher.send, ledger: teacher.ledger, charge: 3,
  })

  const records = await waitFor(async () => {
    const rows = await listReceivedRecords(studentStore, studentId)
    return rows.length === 1 ? rows : null
  })
  expect(records[0].encounter.id).toBe(final.id)
  expect(records[0].encounter.plan.prescription.value).toEqual({ items: [{ herb: '合成药', dose: '3g' }], days: 3 })

  // 作业进了 M1-13 的集合，startsOn 取收到当天。
  const assignments = await waitFor(async () => {
    const rows = await studentStore.list('homework')
    return rows.length === 1 ? rows : null
  })
  const assignment = assignments[0].value as unknown as { homework: Homework; startsOn: string }
  expect(assignment.homework.title).toBe('按揉太渊穴')
  expect(assignment.startsOn).toBe(localDay(new Date()))

  // 两端余额 -3 且对账码相同。
  const paired = await waitFor(async () => {
    const a = await teacher.ledger.view(teacherPub, studentPub)
    const b = await student.ledger.view(teacherPub, studentPub)
    return a.balance === -3 && b.balance === -3 && a.code === b.code && a.code !== null ? { a, b } : null
  })
  expect(paired.a.code).toBe(paired.b.code)
})

it('3 照片缺一张时老师端不能起草，补到后可以', async () => {
  const { student, teacherStore } = await nodes()
  const pkg = await syntheticPackage(2)
  const [first, second] = pkg.attachments
  await student.send(pkg.encounter.teacher, consultEnvelope(pkg))
  await student.send(pkg.encounter.teacher, {
    type: 'consult.attachment', version: 1,
    payload: { encounterId: pkg.encounter.id, ref: first.ref, data: toBase64(first.data) },
  })
  await waitFor(async () => (await consultReadiness(teacherStore, pkg.encounter.id)).total === 2)
  const partial = await consultReadiness(teacherStore, pkg.encounter.id)
  expect(partial.arrived).toBe(1)
  expect(partial.missing).toEqual([second.ref.id])
  await expect(assertConsultReady(teacherStore, pkg.encounter.id)).rejects.toThrow('照片还在路上')
  await student.send(pkg.encounter.teacher, {
    type: 'consult.attachment', version: 1,
    payload: { encounterId: pkg.encounter.id, ref: second.ref, data: toBase64(second.data) },
  })
  await waitFor(async () => (await consultReadiness(teacherStore, pkg.encounter.id)).ready)
  expect((await assertConsultReady(teacherStore, pkg.encounter.id)).encounter.id).toBe(pkg.encounter.id)
})

it('4 篡改过的签字病历学生端不显示', async () => {
  const { teacher, teacherStore, studentStore } = await nodes()
  // 先把这个老师登记进“我的老师”，否则学生端按白名单直接丢弃。
  await addTeacher(studentStore, teacherPub)
  const pkg = await syntheticPackage(0)
  const signed = signEncounter(pkg.encounter, teacherId.privateKey)
  await teacher.send(studentPub, { type: 'record.signed', version: 1, payload: signed })
  await waitFor(async () => (await listReceivedRecords(studentStore, studentId)).length === 1)
  const tampered = { ...signed, content: signed.content.replace('"version":1', '"version":9') }
  await teacher.send(studentPub, { type: 'record.signed', version: 1, payload: tampered })
  await new Promise(resolve => setTimeout(resolve, 200))
  const records = await listReceivedRecords(studentStore, studentId)
  expect(records).toHaveLength(1)
  expect(records[0].event.id).toBe(signed.id)
  expect(groupReceivedRecords(records)).toHaveLength(1)
  expect(await teacherStore.list('student-records')).toHaveLength(0)
})

it('5 每条消息发送后调用一次 notifyRecipient；notifyRecipient 抛错时发送仍算成功', async () => {
  const studentNotifier = vi.fn().mockRejectedValue(new Error('push offline'))
  const { student, teacherStore } = await nodes({ studentNotifier })
  const pkg = await syntheticPackage(2)
  await student.sendConsult(pkg)
  await waitFor(async () => {
    const rows = await listConsults(teacherStore)
    if (rows.length !== 1) return false
    return (await consultReadiness(teacherStore, pkg.encounter.id)).ready
  })
  // 问诊包 1 条 + 照片 2 条：每条都通知了老师，学生端的通知失败没有影响发送。
  expect(studentNotifier).toHaveBeenCalledTimes(3)
  expect(studentNotifier.mock.calls.every(call => call[0] === teacherPub)).toBe(true)
})

it('7 加固：急症后重启会删除旧草稿；intake-outbox 改为真实发送并删除', async () => {
  const { student, teacherStore } = await nodes()
  // 急症后重启删除旧草稿。
  const state = startSession({ student: studentPub, teacher: teacherPub, template: template as TeacherTemplate, id: 'b'.repeat(32) })
  const store = await testStore(studentId)
  await saveDraft(store, state)
  const restarted = await restartIntakeAfterEmergency(store, state)
  expect(restarted.encounterId).not.toBe(state.encounterId)
  expect((await store.list('intake-draft')).some(row => (row.value as { encounterId?: string }).encounterId === state.encounterId)).toBe(false)

  // intake-outbox 里的替身待发件改为真实发送，发送成功即删除。
  const pkg = await syntheticPackage(1)
  const { saveStoredPackage } = await import('../intake/session')
  await saveStoredPackage(store, pkg, 'intake-outbox', pkg.encounter.id)
  expect(await store.list('intake-outbox')).toHaveLength(1)
  const flushed = await flushIntakeOutbox(store, student.send)
  expect(flushed).toBe(1)
  await waitFor(async () => (await consultReadiness(teacherStore, pkg.encounter.id)).ready)
  expect(await store.list('intake-outbox')).toHaveLength(0)
})

it('8 陌生成员签发的病历不显示、作业不进 homework；旧数据也按“我的老师”过滤', async () => {
  const relay = new MemoryRelay()
  const strangerId = createIdentity(phrase, 'english', 2)
  relay.members.add(strangerId.publicKey)
  const studentNode = await openNode(studentId, relay)
  const strangerNode = await openNode(strangerId, relay)
  await waitFor(() => studentNode.status.value === 'ready' && strangerNode.status.value === 'ready')

  const strangerEvent = signedRecordFor(strangerId, { homework: true })
  await strangerNode.wiring.send(studentPub, { type: 'record.signed', version: 1, payload: strangerEvent })
  await new Promise(resolve => setTimeout(resolve, 300))
  // 名单为空：陌生成员的病历不写库，作业也不进 M1-13 集合。
  expect(await studentNode.store.list('student-records')).toHaveLength(0)
  expect(await studentNode.store.list('homework')).toHaveLength(0)
  expect(await listReceivedRecords(studentNode.store, studentId)).toHaveLength(0)

  // 旧数据（白名单之前已经写进本机的）在显示时同样按名单过滤。
  await studentNode.store.put('student-records', strangerEvent.id, {
    id: 'd'.repeat(32),
    teacher: strangerId.publicKey,
    createdAt: '2026-10-17T09:00:00.000Z',
    eventJson: JSON.stringify(strangerEvent),
    version: 1,
  } as unknown as StoreValue)
  expect(await listReceivedRecords(studentNode.store, studentId)).toHaveLength(0)
  // 手动登记后同一份旧数据才显示（名单决定可见性）。
  await addTeacher(studentNode.store, strangerId.publicKey)
  expect(await listReceivedRecords(studentNode.store, studentId)).toHaveLength(1)
  await removeTeacher(studentNode.store, strangerId.publicKey)
  expect(await listReceivedRecords(studentNode.store, studentId)).toHaveLength(0)
})

it('9 已登记老师正常显示并进作业；已发出的问诊包会自动把老师加入名单', async () => {
  const { teacher, student, studentStore } = await nodes()
  const pkg = await syntheticPackage(0)
  expect(await loadTeachers(studentStore)).toHaveLength(0)
  await student.sendConsult(pkg)
  // 问诊包发送成功后自动加入“我的老师”。
  await waitFor(async () => (await loadTeachers(studentStore)).includes(teacherPub))

  const event = signedRecordFor(teacherId, { homework: true })
  await teacher.send(studentPub, { type: 'record.signed', version: 1, payload: event })
  const records = await waitFor(async () => {
    const rows = await listReceivedRecords(studentStore, studentId)
    return rows.length === 1 ? rows : null
  })
  expect(records[0].teacher).toBe(teacherPub)
  const homework = await waitFor(async () => {
    const rows = await studentStore.list('homework')
    return rows.length === 1 ? rows : null
  })
  expect((homework[0].value as { homework: { title: string } }).homework.title).toBe('合成作业')

  // 改名单位后旧病历不再显示；重新登记后恢复，且非法公钥被拒绝。
  await removeTeacher(studentStore, teacherPub)
  expect(await listReceivedRecords(studentStore, studentId)).toHaveLength(0)
  await expect(addTeacher(studentStore, 'not-a-key')).rejects.toThrow('64 位十六进制')
  await addTeacher(studentStore, teacherPub)
  expect(await listReceivedRecords(studentStore, studentId)).toHaveLength(1)
})

it('6 375px 截图：学生病历页、老师问诊箱', () => {
  expect(existsSync(new URL('../../../../docs/screenshots/student-records-375.png', import.meta.url))).toBe(true)
  expect(existsSync(new URL('../../../../docs/screenshots/teacher-inbox-375.png', import.meta.url))).toBe(true)
  expect(existsSync(new URL('../../records.css', import.meta.url))).toBe(true)
  expect(existsSync(new URL('../../inbox.css', import.meta.url))).toBe(true)
})

it('completed consultation replay cannot resurrect teacher raw package or photo', async () => {
  const { teacher, student, teacherStore } = await nodes()
  const pkg = await syntheticPackage(1)
  await student.sendConsult(pkg)
  const consult = await waitFor(async () => {
    const rows = await listConsults(teacherStore)
    if (rows.length !== 1) return null
    return (await consultReadiness(teacherStore, rows[0].encounter.id)).ready ? rows[0] : null
  })
  await completeConsultSigning({ identity:teacherId,store:teacherStore,consult,draft:consult.encounter,final:consult.encounter,send:teacher.send })
  await teacher.inbox.receive({ id:crypto.randomUUID(),sender:studentPub,at:Math.floor(Date.now()/1000),envelope:consultEnvelope(pkg) })
  await teacher.inbox.receive({ id:crypto.randomUUID(),sender:studentPub,at:Math.floor(Date.now()/1000),envelope:{type:'consult.attachment',version:1,payload:{encounterId:pkg.encounter.id,ref:pkg.attachments[0].ref,data:toBase64(pkg.attachments[0].data)}} })
  expect(await teacherStore.list('consult-package')).toHaveLength(0)
  expect(await teacherStore.list('attachments')).toHaveLength(0)
})
