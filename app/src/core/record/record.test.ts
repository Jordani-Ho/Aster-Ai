import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Encounter, Field } from './types'
import {
  deidentifiedCaseBook,
  modificationLog,
  nextVersion,
  pendingDraftFields,
  signEncounter,
  verifySignedEncounter,
  type SignedEncounterEvent,
} from './sign'
import {
  RECORD_COLLECTIONS,
  completeSigning,
  saveSignedEncounter,
  type RecordStore,
} from './handover'

// 合成身份与合成病历，不使用任何真实资料。
const teacherKey = generateSecretKey()
const teacher = getPublicKey(teacherKey)
const studentKey = generateSecretKey()
const student = getPublicKey(studentKey)
const otherTeacherKey = generateSecretKey()
const otherTeacher = getPublicKey(otherTeacherKey)
const otherStudent = getPublicKey(generateSecretKey())

function field<T>(value: T | null, source: Field<T>['source'] = 'teacher'): Field<T> {
  return { value, source }
}

function makeEncounter(overrides: Partial<Encounter> = {}): Encounter {
  return {
    id: 'a'.repeat(32),
    version: 1,
    kind: 'remote_async',
    student,
    teacher,
    createdAt: '2026-01-01T00:00:00.000Z',
    profile: {
      alias: field('合成称呼'),
      gender: field('female'),
      age: field(35),
      bazi: field({ year: null, month: null, day: '甲子', hour: null, flags: [] }),
      city: field('合成城市'),
    },
    intake: {
      chiefComplaint: field('SYNTHETIC_CHIEF_COMPLAINT', 'student'),
      presentIllness: field('SYNTHETIC_ILLNESS', 'student'),
      history: field<string>(null, 'student'),
      medsAllergies: field<string>(null, 'student'),
      attachments: [{ id: 'att-1', type: 'photo', sha256: 'b'.repeat(64), bytes: 1234 }],
    },
    fourExams: { look: field('合成望诊'), listenSmell: field('合成闻诊'), ask: field('合成问诊'), pulse: field('合成切诊') },
    judgment: {
      symptomSummary: field('合成症状摘要'),
      pattern: field('合成证候'),
      mechanism: field('合成病机'),
      rationale: field('合成依据'),
    },
    plan: {
      principle: field('合成治则'),
      prescription: field({ items: [{ herb: '合成药', dose: '3g' }], days: 3 }),
      homework: [{ id: 'hw-1', title: '合成作业', detail: '合成说明', schedule: { kind: 'daily', time: '08:00' }, source: 'teacher' }],
      advice: field('合成医嘱'),
    },
    ...overrides,
  }
}

function draftEncounter(): Encounter {
  const draft = makeEncounter()
  draft.judgment.pattern = field('AI 合成证候', 'ai_draft')
  draft.plan.homework[0] = { ...draft.plan.homework[0], source: 'ai_draft' }
  return draft
}

// 老师逐项确认：AI 草稿改为老师判断。
function confirmAll(draft: Encounter, pattern = '老师定稿证候'): Encounter {
  const final = structuredClone(draft)
  final.judgment.pattern = { value: pattern, source: 'teacher', note: 'ai_accepted' }
  final.plan.homework[0] = { ...final.plan.homework[0], source: 'teacher', note: 'ai_accepted' }
  return final
}

class MemoryStore implements RecordStore {
  private data = new Map<string, Map<string, unknown>>()
  async put(collection: string, key: string, value: unknown) {
    if (!this.data.has(collection)) this.data.set(collection, new Map())
    this.data.get(collection)!.set(key, value)
  }
  async get(collection: string, key: string) {
    return this.data.get(collection)?.get(key)
  }
  async delete(collection: string, key: string) {
    this.data.get(collection)?.delete(key)
  }
  async list(collection: string) {
    return [...(this.data.get(collection)?.entries() ?? [])].map(([key, value]) => ({ key, value }))
  }
}

async function signedPair(draft = draftEncounter()) {
  const final = confirmAll(draft)
  const signed = signEncounter(final, teacherKey)
  return { draft, final, signed }
}

describe('M1-11 签字与交还验收', () => {
  it('1 还有 ai_draft 时签字抛错，全部确认后可以签字', () => {
    const draft = draftEncounter()
    expect(pendingDraftFields(draft)).toContain('judgment.pattern')
    expect(pendingDraftFields(draft)).toContain('plan.homework[0]')
    expect(() => signEncounter(draft, teacherKey)).toThrow('未确认')
    const signed = signEncounter(confirmAll(draft), teacherKey)
    expect(signed.kind).toBe(2730)
    expect(signed.tags).toContainEqual(['p', student])
    expect(signed.tags).toContainEqual(['encounter', draft.id, '1'])
  })

  it('2 签字事件可通过验签；改动 content 后校验失败', () => {
    const signed = signEncounter(confirmAll(draftEncounter()), teacherKey)
    expect(verifySignedEncounter(signed, { student, teacher }).id).toBe('a'.repeat(32))
    const tampered = { ...signed, content: signed.content.replace('老师定稿证候', '篡改证候') }
    expect(() => verifySignedEncounter(tampered, { student, teacher })).toThrow('篡改')
  })

  it('3 签名人不是自己的老师或 p 标签不是自己时拒绝', () => {
    const final = confirmAll(draftEncounter())
    const signed = signEncounter(final, teacherKey)
    expect(() => verifySignedEncounter(signed, { student, teacher: otherTeacher })).toThrow('不是这位学生的老师')
    expect(() => verifySignedEncounter(signed, { student: otherStudent, teacher })).toThrow('不属于当前学生')
    const wrongPTag = finalizeEvent({
      kind: 2730,
      created_at: Math.floor(Date.parse(final.createdAt) / 1000),
      tags: [['encounter', final.id, '1'], ['p', otherStudent]],
      content: JSON.stringify(final),
    }, teacherKey) as SignedEncounterEvent
    expect(() => verifySignedEncounter(wrongPTag, { student, teacher })).toThrow('p 标签')
  })

  it('4 签字后问诊包和附件被删除，日志只有时间与病历 id', async () => {
    const store = new MemoryStore()
    const { draft, final, signed } = await signedPair()
    await store.put(RECORD_COLLECTIONS.consultPackage, final.id, { chiefComplaint: 'SYNTHETIC_CHIEF_COMPLAINT' })
    await store.put(RECORD_COLLECTIONS.attachments, 'att-1', { bytes: new Uint8Array([1, 2, 3]) })
    const sent: { type: string; payload: SignedEncounterEvent }[] = []
    await completeSigning({
      store, encounter: final, draft, signed, attachmentIds: ['att-1'],
      send: async (type, payload) => { sent.push({ type, payload }) },
    })
    expect(await store.get(RECORD_COLLECTIONS.consultPackage, final.id)).toBeUndefined()
    expect(await store.get(RECORD_COLLECTIONS.attachments, 'att-1')).toBeUndefined()
    const logs = await store.list(RECORD_COLLECTIONS.recordLog)
    expect(logs).toHaveLength(1)
    const log = logs[0].value as Record<string, unknown>
    expect(Object.keys(log).sort()).toEqual(['at', 'encounterId'])
    expect(JSON.stringify(log)).not.toContain('SYNTHETIC')
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('record.signed')
    expect(sent[0].payload.id).toBe(signed.id)
    const stored = await store.get(RECORD_COLLECTIONS.signedEncounters, final.id + '-v1') as SignedEncounterEvent
    expect(verifySignedEncounter(stored, { student, teacher }).id).toBe(final.id)
  })

  it('5 去标识医案不含公钥、称呼、主诉和附件，年龄只保留年龄段', async () => {
    const store = new MemoryStore()
    const { draft, final, signed } = await signedPair()
    await completeSigning({ store, encounter: final, draft, signed, attachmentIds: [], send: async () => {} })
    const stored = await store.get(RECORD_COLLECTIONS.caseBook, final.id + '-v1') as { deidentified: Record<string, unknown>; modifications: unknown[] }
    const text = JSON.stringify(stored.deidentified)
    expect(text).not.toContain(student)
    expect(text).not.toContain('合成称呼')
    expect(text).not.toContain('SYNTHETIC_CHIEF_COMPLAINT')
    expect(text).not.toContain('b'.repeat(64))
    expect(stored.deidentified.ageBand).toBe('30-39 岁')
    expect(Object.keys(stored.deidentified).sort()).toEqual(['ageBand', 'gender', 'judgment', 'plan'])
    expect(stored.modifications.length).toBeGreaterThan(0)
  })

  it('6 修改记录里保留 AI 原文和老师定稿', async () => {
    const store = new MemoryStore()
    const { draft, final, signed } = await signedPair()
    await completeSigning({ store, encounter: final, draft, signed, attachmentIds: [], send: async () => {} })
    const stored = await store.get(RECORD_COLLECTIONS.caseBook, final.id + '-v1') as { modifications: { path: string; aiDraft: unknown; final: unknown }[] }
    const pattern = stored.modifications.find(entry => entry.path === 'judgment.pattern')
    expect(pattern).toEqual({ path: 'judgment.pattern', aiDraft: 'AI 合成证候', final: '老师定稿证候' })
    expect(stored.modifications.some(entry => entry.path === 'plan.homework[0]')).toBe(true)
  })

  it('7 修改已签字病历生成第 2 版，supersedes 正确且第 1 版仍可读', async () => {
    const store = new MemoryStore()
    const { draft, final, signed } = await signedPair()
    await completeSigning({ store, encounter: final, draft, signed, attachmentIds: [], send: async () => {} })
    const next = nextVersion(final, signed.id, { createdAt: '2026-02-01T00:00:00.000Z' })
    expect(next.version).toBe(2)
    expect(next.supersedes).toBe(signed.id)
    expect(next.id).toMatch(/^[0-9a-f]{32}$/)
    const nextSigned = signEncounter(next, teacherKey)
    await saveSignedEncounter(store, nextSigned, next)
    expect((await store.list(RECORD_COLLECTIONS.signedEncounters)).length).toBe(2)
    const first = await store.get(RECORD_COLLECTIONS.signedEncounters, final.id + '-v1') as SignedEncounterEvent
    expect(first.id).toBe(signed.id)
    expect(verifySignedEncounter(nextSigned, { student, teacher }).version).toBe(2)
  })

  it('8 签字模块及其依赖不导入任何模型客户端', () => {
    const directory = 'src/core/record'
    for (const file of readdirSync(directory).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = readFileSync(join(directory, file), 'utf8')
      expect(source, file).not.toMatch(/from\s+['"][^'"]*llm|openai/i)
    }
  })

  it('替换/去标识函数本身不泄漏原文', () => {
    const final = confirmAll(draftEncounter(), '老师定稿证候')
    const caseBook = deidentifiedCaseBook(final)
    expect(JSON.stringify(caseBook)).not.toContain('SYNTHETIC_CHIEF_COMPLAINT')
    const log = modificationLog(draftEncounter(), final)
    expect(log.find(entry => entry.path === 'judgment.pattern')?.aiDraft).toBe('AI 合成证候')
  })
})
