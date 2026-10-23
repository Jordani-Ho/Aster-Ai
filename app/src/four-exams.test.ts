import { describe, expect, it, vi } from 'vitest'
import type { LlmClient } from './core/llm'
import { fallbackSplit, splitFourExams, validateSplit } from './four-exams'

const model = (data: unknown): LlmClient => ({ complete: vi.fn().mockResolvedValue(JSON.stringify(data)), stream: vi.fn() })

describe('V2-16 面诊口述拆四诊（合成数据）', () => {
  it('有模型时只接受原话里的片段，拆成四格', async () => {
    const text = '舌淡红，苔薄白，边上有齿痕；入睡难，多梦；脉细弱'
    const result = await splitFourExams(text, model({
      look: ['舌淡红，苔薄白，边上有齿痕'],
      listenSmell: [],
      ask: ['入睡难，多梦'],
      pulse: ['脉细弱'],
    }))
    expect(result.usedModel).toBe(true)
    expect(result.fragments.look).toEqual(['舌淡红，苔薄白，边上有齿痕'])
    expect(result.fragments.ask).toEqual(['入睡难，多梦'])
    expect(result.fragments.pulse).toEqual(['脉细弱'])
    expect(result.fragments.listenSmell).toEqual([])
  })

  it('模型改写或编造的片段被丢弃，退回本地拆分', async () => {
    const text = '舌淡红，苔薄白'
    const result = await splitFourExams(text, model({ look: ['舌淡红，苔薄白，脉弦'], pulse: ['脉弦'] }))
    expect(result.usedModel).toBe(false)
    expect(result.fragments.look).toEqual(['舌淡红，苔薄白'])
    expect(result.fragments.pulse).toEqual([])
  })

  it('没有模型或模型报错时，本地按关键词拆分，不阻断流程', async () => {
    const text = '舌淡红，苔薄白；脉细弱；入睡难'
    const offline = await splitFourExams(text, null)
    expect(offline.usedModel).toBe(false)
    expect(offline.fragments.look).toEqual(['舌淡红，苔薄白'])
    expect(offline.fragments.pulse).toEqual(['脉细弱'])
    expect(offline.fragments.ask).toEqual(['入睡难'])
    const broken: LlmClient = { complete: vi.fn().mockRejectedValue(new Error('offline')), stream: vi.fn() }
    const failed = await splitFourExams(text, broken)
    expect(failed.fragments.look).toEqual(['舌淡红，苔薄白'])
  })

  it('空话不产生字段；没有关键词的短句归到问', () => {
    expect(fallbackSplit('   ')).toEqual({ look: [], listenSmell: [], ask: [], pulse: [] })
    expect(fallbackSplit('昨晚吃了点粥')).toEqual({ look: [], listenSmell: [], ask: ['昨晚吃了点粥'], pulse: [] })
    expect(validateSplit({ look: ['不在原文里'] }, '舌淡红')).toBeNull()
  })
})
