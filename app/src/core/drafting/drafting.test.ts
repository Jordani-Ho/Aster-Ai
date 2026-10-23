import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ConsultPackage, Encounter } from '../record/types'
import type { LlmClient } from '../llm'
import { draftEncounter, type DraftMaterials, type DraftOptions } from './index'
import { searchCases } from './cases'
import template from '../../../../domain/tcm/templates/default.json'

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

// V2-19：起草现在收「材料对象」并返回 { encounter, note }；这些旧用例只关心病历本身。
const run = async (input: ConsultPackage, materials: DraftMaterials, llm: LlmClient, options?: DraftOptions): Promise<Encounter> =>
  (await draftEncounter(input, materials, llm, options)).encounter

describe('老师起草验收（仅合成资料和模拟模型）', () => {
  it('正常字段逐项写入，来源强制 ai_draft；不修改输入', async () => {
    const input = pkg(); const before = structuredClone(input)
    const result = await run(input, { template }, model(output), { level: 'prescription' })
    expect(result.fourExams.ask).toEqual({ value: '睡眠不佳', source: 'ai_draft' })
    expect(result.judgment.pattern.source).toBe('ai_draft')
    expect(result.plan.prescription.source).toBe('ai_draft')
    expect(input).toEqual(before)
  })
  it('丢弃模型改写的学生资料及身份、历史结果', async () => {
    const input = pkg()
    const result = await run(input, { template }, model({ ...output, intake: { chiefComplaint: '篡改' }, profile: {}, teacher: '篡改', outcome: {} }))
    expect(result.intake).toEqual(input.encounter.intake)
    expect(result.profile).toEqual(input.encounter.profile)
    expect(result.teacher).toBe(input.encounter.teacher)
    expect(result.outcome).toBeUndefined()
  })
  it('缺失证候为 null；非法字段为 null 并注明', async () => {
    const result = await run(pkg(), { template }, model({ judgment: { mechanism: { value: 42 } } }), { level: 'pattern' })
    expect(result.judgment.pattern.value).toBeNull()
    expect(result.judgment.mechanism).toMatchObject({ value: null, source: 'unknown', note: expect.any(String) })
  })
  it('默认 record 丢弃辨证和处理；pattern 不允许方子；prescription 允许', async () => {
    for (const level of ['record', 'pattern', 'prescription'] as const) {
      const result = await run(pkg(), { template }, model(output), { level })
      expect(result.plan.prescription.value !== null).toBe(level === 'prescription')
      expect(result.judgment.pattern.value !== null).toBe(level !== 'record')
    }
    expect((await run(pkg(), { template }, model(output))).plan.prescription.value).toBeNull()
  })
  it('非法 JSON、拒绝、超时都返回学生资料并通过回调提示错误，不泄露上游错误', async () => {
    vi.useFakeTimers()
    try {
      for (const complete of [vi.fn().mockResolvedValue('不是 JSON'), vi.fn().mockRejectedValue(new Error('敏感上游内容')), vi.fn(() => new Promise<string>(() => {}))]) {
        const onError = vi.fn()
        const pending = draftEncounter(pkg(), { template }, { complete, stream: vi.fn() }, { timeoutMs: 10, onError })
        await vi.advanceTimersByTimeAsync(11)
        const result = (await pending).encounter
        expect(result.intake).toEqual(pkg().encounter.intake)
        expect(Object.values(result.judgment).every(field => field.value === null && field.source === 'unknown')).toBe(true)
        expect(result.judgment.symptomSummary.note).toContain('起草失败')
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('起草失败'))
        expect(JSON.stringify(onError.mock.calls)).not.toContain('敏感上游内容')
      }
    } finally { vi.useRealTimers() }
  })
  it('检索五份合成医案，相关优先，最多三份，不修改原数组', () => {
    const cases = ['失眠 心脾两虚', '失眠', '腰痛', '心脾两虚', '咳嗽'].map((text, i) => ({ id: String(i), symptomSummary: text, pattern: text }))
    expect(searchCases('失眠 心脾两虚', cases).map(c => c.id)).toEqual(['0', '3', '1'])
    expect(cases[0].id).toBe('0')
    expect(searchCases('', cases)).toEqual([])
  })
  it('提示词包含全部禁止事项和输出约定', () => {
    const prompt = readFileSync(new URL('../../../../prompts/teacher/draft-encounter.md', import.meta.url), 'utf8')
    for (const sentence of ['fourExams', 'judgment', 'plan', '不得改动 intake 和 profile', '资料不足时填 null', '不得编造', '不得承诺疗效', '治愈', '包治', 'JSON', '不得签字']) expect(prompt).toContain(sentence)
  })
  it('无空格口语按汉字二元组命中相关医案；同分按 id 稳定排序', () => {
    const cases = [
      { id: 'z', symptomSummary: '多梦易醒', pattern: '' },
      { id: 'b', symptomSummary: '胃脘胀满', pattern: '' },
      { id: 'a', symptomSummary: '入睡困难，多梦易醒，心悸乏力', pattern: '' },
    ]
    const result = searchCases('最近总是睡不着，晚上多梦，心慌', cases)
    expect(result.map(item => item.id)).toEqual(['a', 'z'])
    expect(searchCases('最近总是睡不着，晚上多梦，心慌', [...cases].reverse())).toEqual(result)
    expect(searchCases('心，慌', [{ id: 'x', symptomSummary: '心慌', pattern: '' }])).toEqual([])
  })
  it.each(['record', 'pattern', 'prescription'] as const)('%s 档的作业权限、来源和本机 id', async level => {
    const homework = { id: 'model-id', title: '合成作业', detail: '合成说明', schedule: { kind: 'daily', time: '08:30' }, source: 'teacher', note: 'ai_accepted' }
    const llm = model({ plan: { homework: [homework, homework] } })
    const result = await run(pkg(), { template }, llm, { level })
    if (level !== 'prescription') expect(result.plan.homework).toEqual([])
    else {
      expect(result.plan.homework).toHaveLength(2)
      for (const item of result.plan.homework) {
        expect(item).toMatchObject({ title: homework.title, detail: homework.detail, schedule: homework.schedule, source: 'ai_draft' })
        expect(item.note).toBeUndefined()
        expect(item.id).not.toBe('model-id')
      }
      expect(result.plan.homework[0].id).not.toBe(result.plan.homework[1].id)
    }
  })
  it('作业的四种合法日程保留，非法日程与字段整条丢弃，不修补', async () => {
    const valid = [{ kind: 'daily', time: '23:59' }, { kind: 'shichen', shichen: '酉' }, { kind: 'jieqi', jieqi: '立冬' }, { kind: 'once', date: '2026-10-16', time: '00:00' }]
    const invalid = [{ kind: 'other' }, { kind: 'daily', time: '8:00' }, { kind: 'daily', time: '24:00' }, { kind: 'daily', time: '12:60' }, { kind: 'shichen', shichen: '甲' }, { kind: 'once', date: '2026-02-30' }, { kind: 'once', date: '2026-10-16', time: 42 }, null]
    const make = (schedule: unknown) => ({ title: '合成作业', detail: '示例', schedule, source: 'teacher' })
    const result = await run(pkg(), { template }, model({ plan: { homework: [...valid.map(make), ...invalid.map(make), { ...make(valid[0]), durationDays: -1 }, { ...make(valid[0]), title: 42 }] } }), { level: 'prescription' })
    expect(result.plan.homework.map(item => item.schedule)).toEqual(valid)
    expect(result.plan.homework.every(item => item.source === 'ai_draft')).toBe(true)
  })
  it('作业只接纳24个标准节气名，伪造名称、别名和空白不修补', async () => {
    const names = ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒']
    const invalid = ['合成节气', '春节', '冬至日', 'DONG_ZHI', ' 立春', '立春 ', '', null, 42]
    const homework = [...names, ...invalid].map(jieqi => ({ title: '合成作业', detail: '合成说明', schedule: { kind: 'jieqi', jieqi } }))
    const result = await run(pkg(), { template }, model({ plan: { homework } }), { level: 'prescription' })
    expect(result.plan.homework.map(item => item.schedule)).toEqual(names.map(jieqi => ({ kind: 'jieqi', jieqi })))
    expect(result.plan.homework.every(item => item.source === 'ai_draft')).toBe(true)
  })
  it('坏方子和作业逐项拒绝；改方必须说明原因；来源不可信', async () => {
    const result = await run(pkg(), { template }, model({ plan: { prescription: { value: { items: [{ herb: '示例', dose: 4 }] } }, homework: [{ id: '1', title: '合成作业', detail: '示例', schedule: { kind: 'daily', time: '99:99' } }] } }), { level: 'prescription' })
    expect(result.plan.prescription.value).toBeNull()
    expect(result.plan.prescription.note).toBeTruthy()
    expect(result.plan.homework).toEqual([])
  })
  it('只给模型选中的去标识范例，不传身份或附件字节；提示词来自文件', async () => {
    const llm = model(output)
    await draftEncounter(pkg(), { template, cases: [{ id: 'example', symptomSummary: '失眠', pattern: '合成证候' }] }, llm)
    const messages = vi.mocked(llm.complete).mock.calls[0][0]
    expect(messages[0].content).toContain('不得改动 intake 和 profile')
    const payload = JSON.parse(messages[1].content)
    expect(payload.cases).toHaveLength(1)
    expect(payload.prior).toEqual([])
    expect(payload.level).toBe('record')
    expect(payload.encounter.student).toBeUndefined()
    expect(payload.encounter.teacher).toBeUndefined()
    expect(payload.attachments).toBeUndefined()
  })
  it('重起草不携带原有判断；档位外的处理不会从旧草稿漏出', async () => {
    const input = pkg()
    input.encounter.plan.advice = { value: '已有草案', source: 'ai_draft' }
    input.encounter.plan.prescription = { value: { items: [{ herb: '合成', dose: '示例' }] }, source: 'teacher' }
    const result = await run(input, { template }, model(output))
    expect(result.plan.advice.value).toBeNull()
    expect(result.plan.prescription.value).toBeNull()
  })
  it('改方引用合法且有理由才保留，模型来源和 note 不会冒充老师', async () => {
    for (const reason of [undefined, '合成修改理由']) {
      const value = { items: [{ herb: '合成', dose: '示例' }], previousOf: 'd'.repeat(64), changeReason: reason }
      const result = await run(pkg(), { template }, model({ plan: { prescription: { value, source: 'teacher', note: 'ai_accepted' } } }), { level: 'prescription' })
      expect(result.plan.prescription.value !== null).toBe(reason !== undefined)
      expect(result.plan.prescription.source).toBe(reason ? 'ai_draft' : 'unknown')
      expect(result.plan.prescription.note).not.toBe('ai_accepted')
    }
  })
})
