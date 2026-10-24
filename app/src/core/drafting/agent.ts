import type { LocalStore } from '../store'
import type { LlmClient } from '../llm'
import type { ConsultPackage, Encounter } from '../record/types'
import { createRunner } from '../agent/runner'
import { AgentError, defineTask, publicKey } from '../agent/tasks'
import { budgetLimit, requestTokens } from './budget'
import { fitDraftMaterials } from './materials'
import { draftEncounter, draftMaterialInput, type DraftMaterials, type DraftOptions, type DraftResult } from './index'

/** 起草对象是一张问诊卡，而不是“学生今天只能问诊一次”。不同 encounter 各有独立草稿。 */
export async function draftWithAgent(store: LocalStore, pkg: ConsultPackage, materials: DraftMaterials, llm: LlmClient, options: DraftOptions & { now?: Date } = {}): Promise<DraftResult> {
  if (!pkg?.encounter || !/^[a-f0-9]{32}$/.test(pkg.encounter.id) || !publicKey(pkg.encounter.student) || !publicKey(pkg.encounter.teacher)) throw new AgentError('input')
  const level = options.level ?? 'record'
  if (!['record', 'pattern', 'prescription'].includes(level) || (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))) throw new AgentError('input')
  type Generated = Pick<Encounter, 'fourExams' | 'judgment' | 'plan'> & { note: string[] }
  const task = defineTask({
    id: 'drafting', side: 'teacher', trigger: { kind: 'manual' }, confirm: 'human',
    gather: async () => ({ pkg, materials }),
    tokens: (data: { pkg: ConsultPackage; materials: DraftMaterials }) => requestTokens(fitDraftMaterials(draftMaterialInput(data.pkg, data.materials, level)).messages),
    run: async (data): Promise<Generated> => {
      let failed = false
      const result = await draftEncounter(data.pkg, data.materials, llm, { ...options, onError: text => { failed = true; options.onError?.(text) } })
      if (failed) throw new AgentError('model_unavailable')
      // 老师已录入的 intake/profile 是只读引用；只有下面这些模型新增字段经过输出守线。
      const { fourExams, judgment, plan } = result.encounter
      return { fourExams, judgment, plan, note: result.note }
    },
    deliver: async () => {}, // 草稿交给既有核对页；签字发出完全不走执行器。
  })
  const result = await createRunner({ store, side: 'teacher', maxTokens: budgetLimit() }).run(task, { targetId: pkg.encounter.id, now: options.now })
  const { note, ...generated } = result.output
  return { encounter: { ...structuredClone(pkg.encounter), ...generated }, note }
}
