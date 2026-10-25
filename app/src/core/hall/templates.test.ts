import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { defaultSchema, validateSchema, TEMPLATE_TYPES } from '../../../../domain/tcm/templates/schema'
import { loadTemplates, saveTemplateDraft, publishTemplate } from '../templates'
import { draftWithAgent } from '../drafting/agent'
import { loadTeacherTemplate } from '../drafting/template'
import { inPersonConsultPackage, startInPersonEncounter } from '../record/in-person'
import { vi } from 'vitest'

it('四类默认骨架可发布；草稿宽松、发布严格，错误指向具体段', () => {
  for (const type of TEMPLATE_TYPES) expect(() => validateSchema(type, defaultSchema(type), true)).not.toThrow()
  expect(() => validateSchema('inquiry', { fields: [] }, false)).not.toThrow()
  expect(() => validateSchema('inquiry', { fields: [] }, true)).toThrow('fields')
  expect(() => validateSchema('record', { sections: [] }, true)).toThrow('sections')
  expect(() => validateSchema('treatment', { content: '' }, false)).not.toThrow()
  expect(() => validateSchema('treatment', { content: '' }, true)).toThrow('content')
  expect(() => validateSchema('prescription', { herbs: [{ herb_name: '合成药', default_amount: -1 }] }, true)).toThrow('default_amount')
})

it('生效四类模板确实进入模型；留待老师的判断不接纳模型填充，仍保留老师原录入', async () => {
  const owner = createIdentity(), store = await openStore(owner, { factory: new IDBFactory() })
  try {
    for (const type of TEMPLATE_TYPES) {
      const schema = defaultSchema(type)
      if (type === 'record') schema.sections.find((item: { key: string }) => item.key === 'judgment').writable_by = 'teacher'
      if (type === 'treatment') schema.content = 'SYNTHETIC_TREATMENT_STYLE'
      await publishTemplate(store, (await saveTemplateDraft(store, type, '合成模板', schema)).id)
    }
    const template = await loadTeacherTemplate(store)
    const encounter = startInPersonEncounter({ teacher: owner.publicKey, student: 'a'.repeat(64) })
    encounter.judgment.pattern = { source: 'teacher', value: 'SYNTHETIC_TEACHER_ONLY' }
    const llm = { complete: vi.fn(async () => JSON.stringify({ judgment: { pattern: { value: 'SYNTHETIC_UNWANTED_AI' } } })), stream: vi.fn() }
    const result = await draftWithAgent(store, inPersonConsultPackage(encounter), { template }, llm, { level: 'prescription' })
    expect(result.encounter.judgment).toEqual(encounter.judgment)
    expect(JSON.stringify(llm.complete.mock.calls)).toContain('SYNTHETIC_TREATMENT_STYLE')
    expect(JSON.stringify(await store.list('agent-runs'))).not.toContain('SYNTHETIC_TEACHER_ONLY')
    expect(JSON.stringify(await store.list('agent-runs'))).not.toContain('SYNTHETIC_UNWANTED_AI')
  } finally { store.close() }
})

it('本机模板发布以单条快照写入，改生效版派生；并发发布每类仅一份生效，失败保留旧版', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const draft = await saveTemplateDraft(store, 'record', '合成病历', defaultSchema('record'))
    await publishTemplate(store, draft.id)
    const revised = await saveTemplateDraft(store, 'record', '合成新版', { ...defaultSchema('record'), tone: { style: 'SYNTHETIC_NEW' } }, draft.id)
    expect(revised.parentId).toBe(draft.id)
    expect(revised.version).toBe(2)
    const failPublish = { get: store.get.bind(store), put: async () => { throw Error('SYNTHETIC_DISK') } }
    await expect(publishTemplate(failPublish, revised.id)).rejects.toThrow('没保存成功')
    expect((await loadTemplates(store)).find(row => row.id === draft.id)?.status).toBe('active')
    await Promise.all([publishTemplate(store, revised.id), publishTemplate(store, revised.id)])
    const rows = await loadTemplates(store)
    expect(rows.filter(row => row.status === 'active')).toHaveLength(1)
    expect(rows.find(row => row.id === draft.id)?.status).toBe('archived')
    const failed = { get: store.get.bind(store), put: async () => { throw Error('SYNTHETIC_DISK') } }
    await expect(saveTemplateDraft(failed, 'record', '失败', defaultSchema('record'), revised.id)).rejects.toThrow('没保存成功')
    expect(await loadTemplates(store)).toEqual(rows)
    await expect(publishTemplate(store, 'bad')).rejects.toThrow()
    await expect(saveTemplateDraft(store, 'record', '', defaultSchema('record'))).rejects.toThrow()
    await expect(saveTemplateDraft(store, 'record', '合成', defaultSchema('record'), crypto.randomUUID())).rejects.toThrow('父版本')
    const wrongType = await saveTemplateDraft(store, 'treatment', '合成', defaultSchema('treatment'))
    await expect(saveTemplateDraft(store, 'record', '合成', defaultSchema('record'), wrongType.id)).rejects.toThrow('父版本')
  } finally { store.close() }
})
