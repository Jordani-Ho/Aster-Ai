import { expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { startInPersonEncounter, inPersonConsultPackage } from '../record/in-person'
import { draftWithAgent } from '../drafting/agent'
import { getDailyMirror } from '../mirror'
import { runRetention } from '../records/retention'
import template from '../../../../domain/tcm/templates/default.json'
import { acceptDraftForSigning } from '../record/sign'
import { signAndHandoverInPerson } from '../record/in-person'

it('同一问诊卡输入不变复用，改一格四诊重新起草；签字成功才清理该卡全部起草副本', async () => {
  const owner = createIdentity(), store = await openStore(owner, { factory: new IDBFactory() })
  try {
    const encounter = startInPersonEncounter({ teacher: owner.publicKey, student: 'a'.repeat(64) })
    const client = { complete: vi.fn(async (messages: { content: string }[]) => JSON.stringify({ judgment: { symptomSummary: { value: JSON.parse(messages[1].content).encounter.fourExams.pulse.value ?? '合成小结' } } })), stream: vi.fn() }
    const options = { now: new Date(2026, 9, 24, 9) }
    const first = await draftWithAgent(store, inPersonConsultPackage(encounter), { template }, client, options)
    expect(await draftWithAgent(store, inPersonConsultPackage(encounter), { template }, client, options)).toEqual(first)
    expect(client.complete).toHaveBeenCalledOnce()
    encounter.fourExams.pulse = { value: 'SYNTHETIC_PULSE_CHANGED', source: 'teacher' }
    const second = await draftWithAgent(store, inPersonConsultPackage(encounter), { template }, client, options)
    expect(client.complete).toHaveBeenCalledTimes(2)
    expect(second.encounter.judgment.symptomSummary.value).toBe('SYNTHETIC_PULSE_CHANGED')
    expect(JSON.stringify(client.complete.mock.calls[1])).toContain('SYNTHETIC_PULSE_CHANGED')
    expect(await draftWithAgent(store, inPersonConsultPackage(encounter), { template }, client, options)).toEqual(second)
    expect(client.complete).toHaveBeenCalledTimes(2)
    expect(await store.list('agent-runs')).toHaveLength(2)
    await store.put('agent-runs', 'other', { taskId: 'drafting', side: 'teacher', targetId: 'b'.repeat(32) })
    await store.put('agent-runs', 'mirror', { taskId: 'mirror', side: 'student', targetId: encounter.id })
    const signing = { encounter: acceptDraftForSigning(second.encounter), privateKey: owner.privateKey, store }
    await expect(signAndHandoverInPerson({ ...signing, send: async () => { throw Error('offline') } })).rejects.toThrow('offline')
    expect(await store.list('agent-runs')).toHaveLength(4)
    await signAndHandoverInPerson({ ...signing, send: async () => {} })
    expect((await store.list('agent-runs')).map(row => row.key).sort()).toEqual(['mirror', 'other'])
  } finally { store.close() }
})

it('起草输入指纹规范化对象键顺序，并包含 intake、profile；坏输入不调用模型', async () => {
  const owner = createIdentity(), store = await openStore(owner, { factory: new IDBFactory() })
  try {
    const encounter = startInPersonEncounter({ teacher: owner.publicKey, student: 'a'.repeat(64) })
    const client = { complete: vi.fn(async () => '{}'), stream: vi.fn() }, options = { now: new Date(2026, 9, 24, 9) }
    await draftWithAgent(store, inPersonConsultPackage(encounter), { template }, client, options)
    encounter.profile = Object.fromEntries(Object.entries(encounter.profile).reverse()) as typeof encounter.profile
    encounter.intake.chiefComplaint = { source: 'unknown', value: null }
    await draftWithAgent(store, inPersonConsultPackage(encounter), { template }, client, options)
    expect(client.complete).toHaveBeenCalledOnce()
    encounter.intake.chiefComplaint.value = 'SYNTHETIC_NEW_INTAKE'
    await draftWithAgent(store, inPersonConsultPackage(encounter), { template }, client, options)
    encounter.profile.alias.value = 'SYNTHETIC_NEW_PROFILE'
    await draftWithAgent(store, inPersonConsultPackage(encounter), { template }, client, options)
    expect(client.complete).toHaveBeenCalledTimes(3)
    encounter.fourExams.pulse.value = Infinity as never
    await expect(draftWithAgent(store, inPersonConsultPackage(encounter), { template }, client, options)).rejects.toThrow('输入')
    expect(client.complete).toHaveBeenCalledTimes(3)
  } finally { store.close() }
})

it('实际起草适配器：同问诊卡并发只起草一次，材料不跨学生；只读老师录入不被当成新写字段', async () => {
  const owner = createIdentity(), store = await openStore(owner, { factory: new IDBFactory() })
  try {
    const first = startInPersonEncounter({ teacher: owner.publicKey, student: 'a'.repeat(64) })
    first.intake.chiefComplaint = { value: 'SYNTHETIC_FIRST_PRIVATE', source: 'teacher', note: 'in_person' }
    const second = startInPersonEncounter({ teacher: owner.publicKey, student: 'b'.repeat(64) })
    second.intake.chiefComplaint = { value: 'SYNTHETIC_SECOND', source: 'student' }
    const client = { complete: vi.fn(async () => JSON.stringify({ judgment: { symptomSummary: { value: '合成小结', source: 'teacher' } } })), stream: vi.fn() }
    const now = new Date(2026, 9, 24, 9)
    const args = { now }
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => draftWithAgent(store, inPersonConsultPackage(first), { template }, client, args)))
    expect(a).toEqual(b); expect(b).toEqual(c); expect(client.complete).toHaveBeenCalledOnce()
    expect(a.encounter.intake.chiefComplaint).toEqual(first.intake.chiefComplaint)
    expect(a.encounter.judgment.symptomSummary.source).toBe('ai_draft')
    await draftWithAgent(store, inPersonConsultPackage(second), { template }, client, args)
    expect(client.complete).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(client.complete.mock.calls[1])).not.toContain('SYNTHETIC_FIRST_PRIVATE')
    const rows = await store.list('agent-runs')
    expect(rows).toHaveLength(2); expect(rows.every(row => (row.value as any).status === 'draft')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain('SYNTHETIC_FIRST_PRIVATE')
    for (const pkg of [null, { encounter: { ...first, id: 'wrong' } }, { encounter: { ...first, student: 'bad' } }]) {
      await expect(draftWithAgent(store, pkg as never, { template }, client)).rejects.toThrow()
    }
    await expect(draftWithAgent(store, inPersonConsultPackage(first), { template }, client, { level: 'anything' as never })).rejects.toThrow()
    await expect(draftWithAgent(store, inPersonConsultPackage(first), { template }, client, { timeoutMs: 0 })).rejects.toThrow()
  } finally { store.close() }
})

it('镜子实际走执行器，跨日和家人分片各自独立；只在本机落结果，不发感受', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const complete = vi.fn(async () => JSON.stringify({ today: ['合成日常建议'] }))
    const input = { carePlan: null, jieqi: '寒露', weather: null, recentCheckins: [], recentSymptoms: [], llm: { complete, stream: vi.fn() }, now: () => new Date(2026, 9, 24, 9) }
    const results = await Promise.all([1, 2, 3].map(() => getDailyMirror(store, input)))
    expect(results[0]).toEqual(results[1]); expect(complete).toHaveBeenCalledOnce()
    expect((await store.list('agent-runs'))[0].value).toMatchObject({ taskId: 'mirror', status: 'delivered' })
    expect(await store.list('agent-sent')).toEqual([])
    for (const row of await store.list('mirror')) await store.delete('mirror', row.key)
    await getDailyMirror(store, input)
    expect(complete).toHaveBeenCalledOnce(); expect(await store.list('mirror')).toHaveLength(1)
    await getDailyMirror(store.scoped('f1-'), input); expect(complete).toHaveBeenCalledTimes(2)
    await getDailyMirror(store, { ...input, now: () => new Date(2026, 9, 25, 9) }); expect(complete).toHaveBeenCalledTimes(3)
    await expect(getDailyMirror(store, { ...input, now: () => new Date(NaN) })).rejects.toThrow()
    await expect(getDailyMirror(store, { ...input, recentCheckins: null as never })).rejects.toThrow()
    await expect(getDailyMirror(store, { ...input, recentStress: 1 as never })).rejects.toThrow()
    await expect(getDailyMirror(store, { ...input, jieqi: 1 as never })).rejects.toThrow()
  } finally { store.close() }
})

it('含健康内容的任务结果随已有保留期清理，不把任务草稿变成长存资料', async () => {
  for (const side of ['teacher', 'student'] as const) {
    const store = await openStore(createIdentity(), { factory: new IDBFactory() })
    try {
      await store.put('agent-runs', 'old', { at: '2020-01-01T00:00:00Z', output: 'SYNTHETIC' })
      await runRetention(store, side, { now: new Date(2026, 9, 24), days: 30 })
      expect(await store.list('agent-runs')).toEqual([])
    } finally { store.close() }
  }
})

it('真实起草失败保留账户类别，不保存上游文字或把失败草稿缓存成成功', async () => {
  const owner = createIdentity(), store = await openStore(owner, { factory: new IDBFactory() })
  try {
    const pkg = inPersonConsultPackage(startInPersonEncounter({ teacher: owner.publicKey, student: 'a'.repeat(64) }))
    const client = { complete: vi.fn(async () => { throw Object.assign(Error('PRIVATE_UPSTREAM_TEXT'), { status: 401 }) }), stream: vi.fn() }
    await expect(draftWithAgent(store, pkg, { template }, client)).rejects.toThrow('账户')
    expect((await store.list('agent-failures'))[0].value).toMatchObject({ kind: 'model_account' })
    expect(JSON.stringify(await store.list('agent-failures'))).not.toContain('PRIVATE')
    expect(await store.list('agent-runs')).toEqual([])
  } finally { store.close() }
})
