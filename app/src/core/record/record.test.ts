import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Encounter, Field } from './types'
import {
  modificationLog,
  nextVersion,
  pendingDraftFields,
  signEncounter,
  verifySignedEncounter,
  type SignedEncounterEvent,
} from './sign'

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
  draft.fourExams.look = field('AI 合成望诊', 'ai_draft')
  draft.judgment.pattern = field('AI 合成证候', 'ai_draft')
  draft.plan.homework[0] = { ...draft.plan.homework[0], source: 'ai_draft' }
  return draft
}

// 老师逐项确认：AI 草稿改为老师判断。
function confirmAll(draft: Encounter, pattern = '老师定稿证候'): Encounter {
  const final = structuredClone(draft)
  final.fourExams.look = { value: '老师定稿望诊', source: 'teacher', note: 'ai_accepted' }
  final.judgment.pattern = { value: pattern, source: 'teacher', note: 'ai_accepted' }
  final.plan.homework[0] = { ...final.plan.homework[0], source: 'teacher', note: 'ai_accepted' }
  return final
}

function forgeSigned(content: Encounter): SignedEncounterEvent {
  return finalizeEvent({
    kind: 2730,
    created_at: Math.floor(Date.parse(content.createdAt) / 1000),
    tags: [['encounter', content.id, String(content.version)], ['p', content.student]],
    content: JSON.stringify(content),
  }, teacherKey) as SignedEncounterEvent
}

describe('M1-11 签字验收（V2-01 起交还不再销毁本机资料）', () => {
  it('1 还有 ai_draft 时签字抛错，全部确认后可以签字', () => {
    const draft = draftEncounter()
    expect(pendingDraftFields(draft)).toContain('fourExams.look')
    expect(pendingDraftFields(draft)).toContain('judgment.pattern')
    expect(pendingDraftFields(draft)).toContain('plan.homework[0]')
    expect(() => signEncounter(draft, teacherKey)).toThrow('未确认')
    const signed = signEncounter(confirmAll(draft), teacherKey)
    expect(signed.kind).toBe(2730)
    expect(signed.tags).toContainEqual(['p', student])
    expect(signed.tags).toContainEqual(['encounter', draft.id, '1'])
    // outcome 里的 ai_draft 也算未确认。
    const withOutcome = confirmAll(draft)
    withOutcome.outcome = { change: field('AI 合成变化', 'ai_draft'), adverse: field<string>(null), next: field<string>(null) }
    expect(pendingDraftFields(withOutcome)).toContain('outcome.change')
    expect(() => signEncounter(withOutcome, teacherKey)).toThrow('未确认')
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

  // 4、5、11 是旧的多步交还（销毁问诊包、写日志/医案/索引、pending 重发）测试；
  // V2-01 删掉 handover.ts 后这些行为不存在，交还流程由 core/inbox 的签字发送测试覆盖。

  it('6 修改记录里保留 AI 原文和老师定稿，且不记四诊', () => {
    const draft = draftEncounter()
    const final = confirmAll(draft)
    const stored = modificationLog(draft, final)
    const pattern = stored.find(entry => entry.path === 'judgment.pattern')
    expect(pattern).toEqual({ path: 'judgment.pattern', aiDraft: 'AI 合成证候', final: '老师定稿证候' })
    expect(stored.some(entry => entry.path === 'plan.homework[0]')).toBe(true)
    expect(stored.some(entry => entry.path === 'fourExams.look')).toBe(false)
  })

  it('7 修改已签字病历生成第 2 版：id 不变、version+1、supersedes 指向旧事件', () => {
    const final = confirmAll(draftEncounter())
    const signed = signEncounter(final, teacherKey)
    const next = nextVersion(final, signed.id, { createdAt: '2026-02-01T00:00:00.000Z' })
    expect(next.id).toBe(final.id)
    expect(next.version).toBe(2)
    expect(next.supersedes).toBe(signed.id)
    const nextSigned = signEncounter(next, teacherKey)
    expect(nextSigned.tags).toContainEqual(['encounter', final.id, '2'])
    expect(verifySignedEncounter(nextSigned, { student, teacher }).version).toBe(2)
  })

  it('8 签字模块及其依赖不导入任何模型客户端', () => {
    const directory = 'src/core/record'
    for (const file of readdirSync(directory).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = readFileSync(join(directory, file), 'utf8')
      expect(source, file).not.toMatch(/from\s+['"][^'"]*llm|openai/i)
    }
  })

  it('9 intake 来源不是学生时拒绝签字；学生端同样拒绝', () => {
    const bad = confirmAll(draftEncounter())
    bad.intake.chiefComplaint = field('老师改写的', 'teacher')
    expect(() => signEncounter(bad, teacherKey)).toThrow('intake')
    const forged = forgeSigned(bad)
    expect(() => verifySignedEncounter(forged, { student, teacher })).toThrow('intake')
  })

  it('10 学生端拒绝带 ai_draft 的签名病历（纵深防御）', () => {
    const forged = forgeSigned(draftEncounter())
    expect(() => verifySignedEncounter(forged, { student, teacher })).toThrow('AI 草稿')
  })

  it('替换函数本身不泄漏原文', () => {
    const final = confirmAll(draftEncounter(), '老师定稿证候')
    const log = modificationLog(draftEncounter(), final)
    expect(log.find(entry => entry.path === 'judgment.pattern')?.aiDraft).toBe('AI 合成证候')
    expect(log.some(entry => entry.path.startsWith('fourExams.'))).toBe(false)
  })
})
