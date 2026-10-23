import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, LlmClient } from '../llm'
import type { ConsultPackage, Encounter } from '../record/types'
import template from '../../../../domain/tcm/templates/default.json'
import { draftEncounter } from './index'
import { priorMaterials } from './materials'

// V2-19 一事一议：两件事各自一次调用，第二次请求里不能带第一位学生的任何内容。
const unknown = () => ({ value: null, source: 'unknown' as const })

const output = {
  fourExams: { ask: { value: '睡眠不佳' } },
  judgment: { symptomSummary: { value: '睡眠困扰' }, pattern: { value: '合成证候' } },
  plan: {},
}

function pkg(marker: string, publicKey: string): ConsultPackage {
  return {
    encounter: {
      id: marker.toLowerCase().padEnd(32, '0').slice(0, 32), version: 1, kind: 'remote_async',
      student: publicKey, teacher: 'e'.repeat(64), createdAt: '2026-10-20T00:00:00Z',
      profile: { alias: { value: '别名' + marker, source: 'student' }, gender: unknown(), age: unknown(), bazi: unknown(), city: unknown() },
      intake: { chiefComplaint: { value: '主诉' + marker, source: 'student' }, presentIllness: { value: '现病史' + marker, source: 'student' }, history: unknown(), medsAllergies: unknown(), attachments: [] },
      fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
      judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
      plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
    },
    history: [],
    attachments: [],
  }
}

function oldRecord(publicKey: string, marker: string): Encounter {
  return {
    ...pkg(marker, publicKey).encounter,
    id: marker.toLowerCase().padEnd(32, '1').slice(0, 32),
    kind: 'in_person',
    judgment: {
      symptomSummary: { value: '旧病历' + marker, source: 'teacher' },
      pattern: { value: '证候' + marker, source: 'teacher' },
      mechanism: unknown(),
      rationale: unknown(),
    },
  }
}

describe('V2-19 一事一议（仅合成资料和模拟模型）', () => {
  it('连续起草两位学生：第二次请求只有 system+user，搜不到第一位学生的任何内容', async () => {
    const calls: ChatMessage[][] = []
    const client: LlmClient = {
      complete: vi.fn(async (messages: ChatMessage[]) => { calls.push(structuredClone(messages)); return JSON.stringify(output) }),
      stream: vi.fn(),
    }
    const firstKey = 'a'.repeat(64)
    const secondKey = 'f'.repeat(64)
    const first = pkg('SYNTHETIC_FIRST', firstKey)
    const second = pkg('SYNTHETIC_SECOND', secondKey)
    const prior = priorMaterials([{ encounter: oldRecord(firstKey, 'SYNTHETIC_OLD_CASE') }])

    const firstResult = await draftEncounter(first, { template, prior }, client)
    expect(firstResult.encounter.intake).toEqual(first.encounter.intake)
    expect(vi.mocked(client.complete)).toHaveBeenCalledTimes(1)

    await draftEncounter(second, { template }, client)
    expect(vi.mocked(client.complete)).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(2)
    expect(calls[1].map(message => message.role)).toEqual(['system', 'user'])

    const secondRequest = JSON.stringify(calls[1])
    for (const secret of ['SYNTHETIC_FIRST', 'SYNTHETIC_OLD_CASE', first.encounter.student, firstKey]) {
      expect(secondRequest).not.toContain(secret)
    }
    expect(secondRequest).not.toContain('assistant')
    expect(JSON.parse(calls[1][1].content).encounter.intake.chiefComplaint.value).toBe('主诉SYNTHETIC_SECOND')
  })
})
