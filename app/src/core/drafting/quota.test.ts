import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, LlmClient } from '../llm'
import type { ConsultPackage, Encounter } from '../record/types'
import template from '../../../../domain/tcm/templates/default.json'
import { draftEncounter } from './index'
import { priorMaterials } from './materials'

// V2-19 额度超限：模型报 402 时按顺序再减一轮材料；仍不行就只用问诊包；三次都失败走固定文案。
const unknown = () => ({ value: null, source: 'unknown' as const })

const output = {
  fourExams: { ask: { value: '睡眠不佳' } },
  judgment: { symptomSummary: { value: '睡眠困扰' }, pattern: { value: '合成证候' } },
  plan: {},
}

function pkg(): ConsultPackage {
  return {
    encounter: {
      id: 'a'.repeat(32), version: 1, kind: 'remote_async', student: 'd'.repeat(64), teacher: 'e'.repeat(64), createdAt: '2026-10-20T00:00:00Z',
      profile: { alias: { value: '合成学生', source: 'student' }, gender: unknown(), age: unknown(), bazi: unknown(), city: unknown() },
      intake: { chiefComplaint: { value: '失眠', source: 'student' }, presentIllness: unknown(), history: unknown(), medsAllergies: unknown(), attachments: [] },
      fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
      judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
      plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
    },
    history: [],
    attachments: [],
  }
}

function largePrior(): Encounter[] {
  return Array.from({ length: 10 }, (_, index) => ({
    ...pkg().encounter,
    id: index.toString(16).padStart(32, 'b'),
    version: 1,
    kind: 'in_person',
    createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    judgment: {
      symptomSummary: { value: '旧病例' + index + '：' + '症状'.repeat(500), source: 'teacher' },
      pattern: { value: '证候' + '证'.repeat(100), source: 'teacher' },
      mechanism: unknown(),
      rationale: unknown(),
    },
  }))
}

function scripted(behaviors: ('ok' | 'quota' | 'fail')[]) {
  const calls: ChatMessage[][] = []
  let index = 0
  const complete = vi.fn(async (messages: ChatMessage[]) => {
    calls.push(structuredClone(messages))
    const behavior = behaviors[index++] ?? 'ok'
    if (behavior === 'quota') throw new Error('模型请求失败：HTTP 402')
    if (behavior === 'fail') throw new Error('模型请求失败：HTTP 500 敏感上游内容')
    return JSON.stringify(output)
  })
  return { client: { complete, stream: vi.fn() } as LlmClient, calls }
}

const payloadOf = (messages: ChatMessage[]) => JSON.parse(messages[1].content)

describe('V2-19 额度超限降级（仅合成资料和模拟模型）', () => {
  it('自家模型报 402：减材料重试一次，成功出草稿并说明减了旧病历', async () => {
    const { client, calls } = scripted(['quota', 'ok'])
    const result = await draftEncounter(pkg(), { template, prior: priorMaterials(largePrior().map(encounter => ({ encounter }))) }, client, { level: 'prescription' })
    expect(calls).toHaveLength(2)
    const first = payloadOf(calls[0])
    const second = payloadOf(calls[1])
    expect(second.prior.length).toBeLessThan(first.prior.length)
    expect(result.note).toContain('旧病历只带了最近 ' + second.prior.length + ' 次')
    expect(result.encounter.judgment.pattern.value).toBe('合成证候')
  })

  it('减材料后仍报 402：只用问诊包与模板起草，并标没参考旧病历和医案', async () => {
    const { client, calls } = scripted(['quota', 'quota', 'ok'])
    const cases = [{ id: 'case-0', symptomSummary: '失眠', pattern: '证候' }]
    const result = await draftEncounter(pkg(), { template, prior: priorMaterials(largePrior().map(encounter => ({ encounter }))), cases }, client, { level: 'prescription' })
    expect(calls).toHaveLength(3)
    const third = payloadOf(calls[2])
    expect(third.prior).toEqual([])
    expect(third.cases).toEqual([])
    expect(third.encounter.intake.chiefComplaint.value).toBe('失眠')
    expect(third.template).toEqual(template)
    expect(result.note).toEqual(['没参考旧病历和医案'])
    expect(result.encounter.judgment.pattern.value).toBe('合成证候')
  })

  it('三段都超限：走现有固定文案回退，不带上游原文或状态码', async () => {
    const { client, calls } = scripted(['quota', 'quota', 'quota'])
    const onError = vi.fn()
    const result = await draftEncounter(pkg(), { template, prior: priorMaterials(largePrior().map(encounter => ({ encounter }))) }, client, { onError })
    expect(calls).toHaveLength(3)
    expect(result.encounter.judgment.symptomSummary.note).toContain('起草失败')
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('起草失败'))
    expect(JSON.stringify(onError.mock.calls)).not.toContain('402')
    expect(JSON.stringify(onError.mock.calls)).not.toContain('敏感上游内容')
    expect(result.note).toEqual([])
  })

  it('非额度错误不重试：只调一次模型，直接走固定文案回退', async () => {
    const { client, calls } = scripted(['fail'])
    const onError = vi.fn()
    await draftEncounter(pkg(), { template, prior: priorMaterials(largePrior().map(encounter => ({ encounter }))) }, client, { onError })
    expect(calls).toHaveLength(1)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('起草失败'))
  })
})
