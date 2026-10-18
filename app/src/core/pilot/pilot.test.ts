import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import type { Encounter } from '../record/types'
import { calculateMetric, saveMetric, rateMetric, exportMetrics } from './index'
const field = (value: string | null = null, source = 'unknown') => ({ value, source })
function draft(): Encounter {
  return { id: '12345678' + 'a'.repeat(24), version: 1, student: 'b'.repeat(64), teacher: 'c'.repeat(64), kind: 'remote_async', createdAt: '2026-10-17T00:00:00Z',
    profile: { alias: field('SYNTHETIC_ALIAS', 'student'), gender: field(), age: field(), bazi: field(), city: field() },
    intake: { chiefComplaint: field('SYNTHETIC_PRIVATE_QUOTE', 'student'), presentIllness: field(), history: field(), medsAllergies: field(), attachments: [] },
    fourExams: { look: field(), listenSmell: field(), ask: field('SYNTHETIC_EXAM', 'ai_draft'), pulse: field() },
    judgment: { symptomSummary: field('SYNTHETIC_SUMMARY', 'ai_draft'), pattern: field('SYNTHETIC_PATTERN', 'ai_draft'), mechanism: field(), rationale: field() },
    plan: { principle: field(), prescription: field(), advice: field(), homework: [{ id: 'synthetic', title: 'SYNTHETIC', detail: 'SYNTHETIC', source: 'ai_draft', schedule: { kind: 'daily', time: '20:00' } }] },
  } as Encounter
}
it('metrics include model time, count actual edits not adoption metadata, and use eight key fields', () => {
  const before = draft(), final = structuredClone(before)
  final.fourExams.ask.source = 'teacher'
  final.judgment.symptomSummary = { value: 'SYNTHETIC_EDIT', source: 'teacher' }
  final.judgment.pattern.source = 'teacher'
  final.plan.homework[0] = { ...final.plan.homework[0], source: 'teacher', note: 'ai_accepted' }
  expect(calculateMetric(before, final, 1000, 2500)).toEqual({ idPrefix: '12345678', durationMs: 1500, modificationRate: 0.25, missingRate: 0.75, resemblance: null, homeworkAdherence: null })
})
it('no AI draft and backwards device clock do not produce NaN or negative duration', () => {
  const before = draft(); before.fourExams.ask.source = 'teacher'; before.judgment.symptomSummary.source = 'teacher'; before.judgment.pattern.source = 'teacher'; before.plan.homework[0].source = 'teacher'
  expect(calculateMetric(before, before, 2500, 1000)).toMatchObject({ durationMs: 0, modificationRate: 0 })
})
it('encrypted metrics and CSV retain only a short id and numbers; rating can be skipped and invalid ratings rejected', async () => {
  const identity = createIdentity('leader monkey parrot ring guide accident before fence cannon height naive bean', 'english')
  const store = await openStore(identity, { factory: new IDBFactory(), name: crypto.randomUUID() })
  try {
    const key = crypto.randomUUID(), metric = calculateMetric(draft(), draft(), 1, 1001)
    await saveMetric(store, key, metric)
    expect(await exportMetrics(store)).toBe('record_id_prefix,draft_to_sign_ms,modification_rate,missing_rate,resemblance,homework_adherence\r\n12345678,1000,0,0.75,,\r\n')
    await rateMetric(store, key, 5)
    expect(await exportMetrics(store)).toContain('12345678,1000,0,0.75,5,\r\n')
    // M1-23a 验收 5：第五列作业坚持率（0～1 或留空），仍不含身份/内容。
    await saveMetric(store, crypto.randomUUID(), calculateMetric(draft(), draft(), 1, 1001, 0.5))
    expect(await exportMetrics(store)).toContain('12345678,1000,0,0.75,,0.5\r\n')
    await expect(rateMetric(store, key, 6)).rejects.toThrow()
    await expect(saveMetric(store, crypto.randomUUID(), { ...metric, idPrefix: '=FORMULA' })).rejects.toThrow()
    const rows = JSON.stringify(await store.list('pilot-metrics'))
    for (const secret of ['SYNTHETIC_PRIVATE_QUOTE', 'SYNTHETIC_ALIAS', 'b'.repeat(64), 'c'.repeat(64), '12345678' + 'a'.repeat(24)]) expect(rows).not.toContain(secret)
    expect(Object.keys((await store.list('pilot-metrics'))[0].value as object).sort()).toEqual(['durationMs','homeworkAdherence','idPrefix','missingRate','modificationRate','resemblance'])
  } finally { store.close() }
})

it('pilot metrics never enter relay backups, including encrypted payloads', async () => {
  const identity = createIdentity('leader monkey parrot ring guide accident before fence cannon height naive bean', 'english')
  const store = await openStore(identity, { factory: new IDBFactory(), name: crypto.randomUUID() })
  const { createBackupManager } = await import('../backup')
  const { v2 } = await import('nostr-tools/nip44')
  let content = ''
  const manager = createBackupManager({ identity, store, relay: { list: async()=>[], publish: async event=>{content=event.content} } })
  try {
    await saveMetric(store,crypto.randomUUID(),calculateMetric(draft(),draft(),0,1000))
    await manager.backupNow()
    const archive=JSON.parse(v2.decrypt(content,v2.utils.getConversationKey(identity.privateKey,identity.publicKey)))
    expect(archive.records.some((r:{c:string})=>r.c==='pilot-metrics')).toBe(false)
    expect(await store.list('pilot-metrics')).toHaveLength(1)
  } finally {manager.close();store.close()}
})
