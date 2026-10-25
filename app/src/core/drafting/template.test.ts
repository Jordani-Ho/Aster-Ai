import { it, expect } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { openStore } from '../store'
import { createIdentity } from '../identity'
import { loadTeacherTemplate } from './template'
import { saveTemplateDraft, publishTemplate } from '../templates'
import { defaultSchema } from '../../../../domain/tcm/templates/schema'
import initial from '../../../../domain/tcm/templates/default.json'
it('旧病历入口只读沿用老设置，新模板发布后读取同一版本库', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    expect(await loadTeacherTemplate(store)).toEqual(initial)
    await store.put('settings', 'teacher-template', { ...initial, name: '合成旧模板' })
    const schema = defaultSchema('record'); schema.tone.style = 'SYNTHETIC_NEW'
    const draft = await saveTemplateDraft(store, 'record', '合成新版', schema)
    expect((await loadTeacherTemplate(store)).name).toBe('合成旧模板')
    await publishTemplate(store, draft.id)
    const active = await loadTeacherTemplate(store)
    expect(active.name).toBe('合成新版'); expect(active.notes).toBe('SYNTHETIC_NEW')
    expect(active.workflow?.record).toEqual(schema)
    expect(active.recordOrder.slice(0, 4)).toEqual(['intake.chiefComplaint', 'intake.presentIllness', 'intake.history', 'intake.medsAllergies'])
  } finally { store.close() }
})
