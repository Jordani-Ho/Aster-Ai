import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ConsultPackage, Encounter } from '../record/types'
import type { LlmClient } from '../llm'
import { draftEncounter } from './index'
import { searchCases } from './cases'
import template from '../../../../../domain/tcm/templates/default.json'

const unknown = () => ({ value: null, source: 'unknown' as const })
function pkg(): ConsultPackage {
  return { encounter: {
    id: 'a'.repeat(32), version: 1, kind: 'remote_async', student: 'b'.repeat(64), teacher: 'c'.repeat(64), createdAt: '2026-10-16T00:00:00Z',
    profile: { alias: { value: '合成学生', source: 'student' }, gender: unknown(), age: unknown(), bazi: unknown(), city: unknown() },
    intake: { chiefComplaint: { value: '失眠', source: 'student' }, presentIllness: unknown(), history: unknown(), medsAllergies: unknown(), attachments: [] },
    fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
    judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
    plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
  }, history: [], attachments: [] }
}
const output = { fourExams: { ask: { value: '睡眠不佳', source: 'teacher' } }, judgment: { symptomSummary: { value: '睡眠困扰' }, pattern: { value: '合成证候' } }, plan: { prescription: { value: { items: [{ herb: '合成药材', dose: '示例剂量' }] } } } }
const model = (data: unknown): LlmClient => ({ complete: vi.fn().mockResolvedValue(JSON.stringify(data)), stream: vi.fn() })

describe('老师起草验收（仅合成资料和模拟模型）', () => {
  it('正常字段逐项写入，来源强制 ai_draft；不修改输入', async () => {
    const input = pkg(); const before = structuredClone(input)
    const result = await draftEncounter(input, template, [], model(output), { level: 'prescription' })
    expect(result.fourExams.ask).toEqual({ value: '睡眠不佳', source: 'ai_draft' })
    expect(result.judgment.pattern.source).toBe('ai_draft')
    expect(result.plan.prescription.source).toBe('ai_draft')
    expect(input).toEqual(before)
  })
  it('丢弃模型改写的学生资料及身份、历史结果', async () => {
    const input = pkg()
    const result = await draftEncounter(input, template, [], model({ ...output, intake: { chiefComplaint: '篡改' }, profile: {}, teacher: '篡改', outcome: {} }))
    expect(result.intake).toEqual(input.encounter.intake)
    expect(result.profile).toEqual(input.encounter.profile)
    expect(result.teacher).toBe(input.encounter.teacher)
    expect(result.outcome).toBeUndefined()
  })
  it('缺失证候为 null；非法字段为 null 并注明', async () => {
    const result = await draftEncounter(pkg(), template, [], model({ judgment: { mechanism: { value: 42 } } }), { level: 'pattern' })
    expect(result.judgment.pattern.value).toBeNull()
    expect(result.judgment.mechanism).toMatchObject({ value: null, source: 'unknown', note: expect.any(String) })
  })
  it('默认 record 丢弃辨证和处理；pattern 不允许方子；prescription 允许', async () => {
    for (const level of ['record', 'pattern', 'prescription'] as const) {
      const result = await draftEncounter(pkg(), template, [], model(output), { level })
      expect(result.plan.prescription.value !== null).toBe(level === 'prescription')
      expect(result.judgment.pattern.value !== null).toBe(level !== 'record')
    }
    expect((await draftEncounter(pkg(), template, [], model(output))).plan.prescription.value).toBeNull()
  })
  it('非法 JSON、拒绝、超时都返回学生资料并通过回调提示错误，不泄露上游错误', async () => {
    vi.useFakeTimers()
    try {
      for (const complete of [vi.fn().mockResolvedValue('不是 JSON'), vi.fn().mockRejectedValue(new Error('敏感上游内容')), vi.fn(() => new Promise<string>(() => {}))]) {
        const onError = vi.fn()
        const pending = draftEncounter(pkg(), template, [], { complete, stream: vi.fn() }, { timeoutMs: 10, onError })
        await vi.advanceTimersByTimeAsync(11)
        const result = await pending
        expect(result.intake).toEqual(pkg().encounter.intake)
        expect(result.judgment).toEqual(pkg().encounter.judgment)
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('起草失败'))
        expect(JSON.stringify(onError.mock.calls)).not.toContain('敏感上游内容')
      }
    } finally { vi.useRealTimers() }
  })
  it('检索五份合成医案，相关优先，最多三份，不修改原数组', () => {
    const cases = ['失眠 心脾两虚', '失眠', '腰痛', '心脾两虚', '咳嗽'].map((text, i) => ({ id: String(i), symptomSummary: text, pattern: text }))
    expect(searchCases('失眠 心脾两虚', cases).map(c => c.id)).toEqual(['0', '1', '3'])
    expect(cases[0].id).toBe('0')
    expect(searchCases('', cases)).toEqual([])
  })
  it('提示词包含全部禁止事项和输出约定', () => {
    const prompt = readFileSync(new URL('../../../../../prompts/teacher/draft-encounter.md', import.meta.url), 'utf8')
    for (const sentence of ['fourExams', 'judgment', 'plan', '不得改动 intake 和 profile', '资料不足时填 null', '不得编造', '不得承诺疗效', '治愈', '包治', 'JSON', '不得签字']) expect(prompt).toContain(sentence)
  })
  it('坏方子和作业逐项拒绝；改方必须说明原因；来源不可信', async () => {
    const result: Encounter = await draftEncounter(pkg(), template, [], model({ plan: { prescription: { value: { items: [{ herb: '示例', dose: 4 }] } }, homework: [{ id: '1', title: '合成作业', detail: '示例', schedule: { kind: 'daily', time: '99:99' } }] } }), { level: 'prescription' })
    expect(result.plan.prescription.value).toBeNull()
    expect(result.plan.prescription.note).toBeTruthy()
    expect(result.plan.homework).toEqual([])
  })
})
