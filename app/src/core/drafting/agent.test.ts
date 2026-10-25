import { expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { ChatMessage, LlmClient } from '../llm'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import type { ConsultPackage } from '../record/types'
import template from '../../../../domain/tcm/templates/default.json'
import { draftWithAgent } from './agent'

const unknown = () => ({ value: null, source: 'unknown' as const })
function packageFor(student: string, teacher: string): ConsultPackage {
  return {
    encounter: {
      id: 'a'.repeat(32), version: 1, kind: 'remote_async', student, teacher, createdAt: '2026-10-25T08:00:00.000Z',
      profile: { alias: { value: '合成学生', source: 'student' }, gender: unknown(), age: unknown(), bazi: unknown(), city: unknown() },
      intake: { chiefComplaint: { value: '合成主诉', source: 'student' }, presentIllness: unknown(), history: unknown(), medsAllergies: unknown(), attachments: [] },
      fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
      judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
      plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
    },
    history: [], attachments: [], homeHerbs: [{ name: '合成黄芪', quantity: 300, unit: '克' }],
  }
}

it('草稿按问诊资料和库存快照哈希复用；库存变化同日重新调用模型', async () => {
  const student = createIdentity(), teacher = createIdentity()
  const store = await openStore(teacher, { factory: new IDBFactory() })
  const calls: ChatMessage[][] = []
  const llm: LlmClient = {
    complete: vi.fn(async (messages: ChatMessage[]) => {
      calls.push(structuredClone(messages))
      return JSON.stringify({ fourExams: {}, judgment: {}, plan: {} })
    }),
    stream: vi.fn(),
  }
  try {
    const pkg = packageFor(student.publicKey, teacher.publicKey)
    const now = new Date('2026-10-25T09:00:00.000Z')
    await draftWithAgent(store, pkg, { template }, llm, { level: 'prescription', now })
    await draftWithAgent(store, structuredClone(pkg), { template }, llm, { level: 'prescription', now })
    expect(llm.complete).toHaveBeenCalledOnce()
    expect(JSON.parse(calls[0][1].content).homeHerbs).toEqual(pkg.homeHerbs)

    pkg.homeHerbs![0] = { name: '合成黄芪', quantity: 250, unit: '克' }
    await draftWithAgent(store, pkg, { template }, llm, { level: 'prescription', now })
    expect(llm.complete).toHaveBeenCalledTimes(2)
    expect(JSON.parse(calls[1][1].content).homeHerbs).toEqual(pkg.homeHerbs)
    expect(await store.list('agent-runs')).toHaveLength(2)
  } finally { store.close() }
})
