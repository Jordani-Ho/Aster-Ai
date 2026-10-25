import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { loadTeacherHerbSnapshot, saveTeacherHerbSnapshot, TEACHER_HERB_SNAPSHOTS } from './snapshots'
import { signEncounter } from '../record/sign'
import { saveTeacherRecord } from '../records/teacher'
import { runRetention } from '../records/retention'
import type { Encounter, Field } from '../record/types'
import type { StoreValue } from '../store'

it('按病历 id 保存老师端库存快照，不把快照混入签名病历', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const encounterId = 'a'.repeat(32)
    const snapshot = [{ name: '合成黄芪', quantity: 300, unit: '克' }]
    await saveTeacherHerbSnapshot(store, encounterId, snapshot)
    expect(await loadTeacherHerbSnapshot(store, encounterId)).toEqual(snapshot)
    expect(await store.get(TEACHER_HERB_SNAPSHOTS, encounterId)).toMatchObject({ encounterId, items: snapshot })
    expect(await store.get('teacher-records', encounterId)).toBeUndefined()
  } finally { store.close() }
})

it('空快照删除旁车；病历 id 不合法或快照格式不合法时不保存', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() })
  try {
    const encounterId = 'b'.repeat(32)
    await saveTeacherHerbSnapshot(store, encounterId, [{ name: '合成药', quantity: 2, unit: '克' }])
    await expect(saveTeacherHerbSnapshot(store, encounterId, [{ name: '', quantity: 2, unit: '克' }])).rejects.toThrow()
    await expect(saveTeacherHerbSnapshot(store, 'bad-id', [])).rejects.toThrow('病历编号')
    await saveTeacherHerbSnapshot(store, encounterId, [])
    expect(await loadTeacherHerbSnapshot(store, encounterId)).toBeUndefined()
  } finally { store.close() }
})

it('库存旁车跟病历保留：问诊包过期但签字病历仍在时保留，病历也过期后清掉', async () => {
  const teacher = createIdentity(), student = createIdentity()
  const store = await openStore(teacher, { factory: new IDBFactory() })
  try {
    const encounterId = 'c'.repeat(32), now = new Date('2026-10-25T12:00:00.000Z')
    const unknown = <T,>(): Field<T> => ({ value: null, source: 'unknown' })
    const encounter: Encounter = {
      id: encounterId, version: 1, kind: 'remote_async', student: student.publicKey, teacher: teacher.publicKey,
      createdAt: '2026-10-20T12:00:00.000Z',
      profile: { alias: { value: '合成学生', source: 'student' }, gender: unknown(), age: unknown(), bazi: unknown(), city: unknown() },
      intake: { chiefComplaint: { value: '合成主诉', source: 'student' }, presentIllness: unknown(), history: unknown(), medsAllergies: unknown(), attachments: [] },
      fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
      judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
      plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
    }
    const signed = signEncounter(encounter, teacher.privateKey)
    expect(JSON.parse(signed.content)).not.toHaveProperty('homeHerbs')
    await saveTeacherRecord(store, signed)
    const snapshot = [{ name: '合成黄芪', quantity: 300, unit: '克' }]
    await saveTeacherHerbSnapshot(store, encounterId, snapshot)
    await store.put('consult-package', encounterId, { encounter: { ...encounter, createdAt: '2026-09-01T12:00:00.000Z' }, receivedAt: '2026-09-01T12:00:00.000Z', attachments: [] } as unknown as StoreValue)

    const first = await runRetention(store, 'teacher', { now, days: 30 })
    expect(first.deleted['consult-package']).toBe(1)
    expect(first.deleted['teacher-records']).toBe(0)
    expect(await loadTeacherHerbSnapshot(store, encounterId)).toEqual(snapshot)

    await store.delete('teacher-records', signed.id)
    const second = await runRetention(store, 'teacher', { now, days: 30 })
    expect(second.deleted[TEACHER_HERB_SNAPSHOTS]).toBe(1)
    expect(await loadTeacherHerbSnapshot(store, encounterId)).toBeUndefined()
  } finally { store.close() }
})
