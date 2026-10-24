import { describe, expect, it, vi } from 'vitest'
import type { ConsultPackage, Encounter } from '../record/types'
import type { ChatMessage, LlmClient } from '../llm'
import template from '../../../../domain/tcm/templates/default.json'
import { AGENT_BUDGET, validateAgentBudget } from '../../../../domain/tcm/agent-budget'
import { draftEncounter } from './index'
import { budgetLimit, estimateTokens, requestTokens } from './budget'
import { fitDraftMaterials, packageOnlyMaterials, priorMaterials } from './materials'

// V2-19 额度上限：全部合成病历与模拟模型，不连真实网关。
const unknown = () => ({ value: null, source: 'unknown' as const })

function syntheticEncounter(index: number): Encounter {
  return {
    id: index.toString(16).padStart(32, '0'),
    version: 1,
    kind: 'in_person',
    student: 'b'.repeat(64),
    teacher: 'c'.repeat(64),
    createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    profile: { alias: { value: '合成学生', source: 'student' }, gender: unknown(), age: unknown(), bazi: unknown(), city: unknown() },
    intake: { chiefComplaint: { value: '主诉' + index, source: 'student' }, presentIllness: unknown(), history: unknown(), medsAllergies: unknown(), attachments: [] },
    fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
    judgment: {
      symptomSummary: { value: '病例' + index + '：' + '症状'.repeat(400), source: 'teacher' },
      pattern: { value: '证候' + '证'.repeat(100), source: 'teacher' },
      mechanism: unknown(),
      rationale: unknown(),
    },
    plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
  }
}

function pkg(options: { complaint?: string; presentIllness?: string } = {}): ConsultPackage {
  return {
    encounter: {
      id: 'a'.repeat(32), version: 1, kind: 'remote_async', student: 'd'.repeat(64), teacher: 'e'.repeat(64), createdAt: '2026-10-20T00:00:00Z',
      profile: { alias: { value: '合成学生', source: 'student' }, gender: unknown(), age: unknown(), bazi: unknown(), city: unknown() },
      intake: {
        chiefComplaint: { value: options.complaint ?? '失眠', source: 'student' },
        presentIllness: options.presentIllness === undefined ? unknown() : { value: options.presentIllness, source: 'student' },
        history: unknown(), medsAllergies: unknown(), attachments: [],
      },
      fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
      judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
      plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
    },
    history: [],
    attachments: [],
  }
}

const output = {
  fourExams: { ask: { value: '睡眠不佳' } },
  judgment: { symptomSummary: { value: '睡眠困扰' }, pattern: { value: '合成证候' } },
  plan: { prescription: { value: { items: [{ herb: '合成药材', dose: '示例剂量' }] } } },
}

function capture() {
  const calls: ChatMessage[][] = []
  const client: LlmClient = {
    complete: vi.fn(async (messages: ChatMessage[]) => { calls.push(structuredClone(messages)); return JSON.stringify(output) }),
    stream: vi.fn(),
  }
  return { client, calls }
}

const payloadOf = (messages: ChatMessage[]) => JSON.parse(messages[1].content)

describe('V2-19 额度上限与材料裁剪（仅合成资料和模拟模型）', () => {
  it('估算公式保守偏高：汉字 1 token，其他字符 1/3 token，向上取整', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('中医')).toBe(2)
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('中a')).toBe(2)
    expect(requestTokens([{ content: '中医' }, { content: 'abc' }])).toBe(3)
  })

  it('额度数值放在 domain 配置：默认 16000，非法配置拒绝', () => {
    expect(AGENT_BUDGET.maxRequestTokens).toBe(16000)
    expect(budgetLimit()).toBe(16000)
    expect(() => validateAgentBudget({ version: 1, maxRequestTokens: 0 })).toThrow()
    expect(() => validateAgentBudget({ version: 0, maxRequestTokens: 16000 })).toThrow()
    expect(() => validateAgentBudget({ version: 1, maxRequestTokens: 1.5 })).toThrow()
  })

  it('30 次病历：请求不超上限，最近的留、最早的减，草稿写明只带了最近几次', async () => {
    const records = Array.from({ length: 30 }, (_, index) => ({ encounter: syntheticEncounter(index) }))
    const prior = priorMaterials(records)
    expect(prior).toHaveLength(30)
    expect(prior[0].symptomSummary).toContain('病例29')
    const { client, calls } = capture()
    const result = await draftEncounter(pkg(), { template, prior }, client)
    const messages = calls[0]
    const payload = payloadOf(messages)
    expect(requestTokens(messages)).toBeLessThanOrEqual(budgetLimit())
    expect(payload.prior.length).toBeGreaterThan(0)
    expect(payload.prior.length).toBeLessThan(30)
    expect(JSON.stringify(payload.prior)).toContain('病例29')
    expect(JSON.stringify(payload.prior)).not.toContain('病例0：')
    expect(result.note).toContain('旧病历只带了最近 ' + payload.prior.length + ' 次')
    expect(result.encounter.intake).toEqual(pkg().encounter.intake)
  })

  it('旧病历减完仍超上限时才减相似医案，并在草稿上说明', async () => {
    const cases = Array.from({ length: 3 }, (_, index) => ({ id: 'case-' + index, symptomSummary: '失眠' + '症'.repeat(5000), pattern: '' }))
    const { client, calls } = capture()
    const result = await draftEncounter(pkg(), { template, cases }, client)
    const payload = payloadOf(calls[0])
    expect(payload.cases.length).toBeLessThan(3)
    expect(result.note.some(line => /相似医案只带了 \d+ 份/.test(line))).toBe(true)
  })

  it('问诊包与模板永远不减：固定材料本身超限也照发，只提示旧病历没带', async () => {
    const long = '长'.repeat(20000)
    const prior = priorMaterials([{ encounter: syntheticEncounter(0) }])
    const { client, calls } = capture()
    const result = await draftEncounter(pkg({ presentIllness: long }), { template, prior }, client)
    const payload = payloadOf(calls[0])
    expect(payload.encounter.intake.presentIllness.value).toBe(long)
    expect(payload.template).toEqual(template)
    expect(result.note).toEqual(['旧病历这次没带'])
    expect(requestTokens(calls[0])).toBeGreaterThan(budgetLimit())
  })

  it('没减东西就不写提示；同一 encounter 只取最新版本；旧病历从新到旧', () => {
    const older = syntheticEncounter(1)
    const newer = { ...structuredClone(older), version: 2, createdAt: new Date(Date.UTC(2026, 0, 20)).toISOString() }
    const list = priorMaterials([{ encounter: older }, { encounter: syntheticEncounter(5) }, { encounter: newer }])
    expect(list.map(item => item.id)).toEqual([older.id, syntheticEncounter(5).id])
    expect(list[0].createdAt > list[1].createdAt).toBe(true)
    const fit = fitDraftMaterials({ prompt: '合成提示词', encounter: pkg().encounter, template, level: 'record', prior: [list[0]], cases: [] })
    expect(fit.note).toEqual([])
    expect(packageOnlyMaterials({ prompt: '合成提示词', encounter: pkg().encounter, template, level: 'record', prior: [list[0]], cases: [] }).note).toEqual(['没参考旧病历和医案'])
  })
})
