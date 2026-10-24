import type { LocalStore } from '../store'
import type { LlmClient } from '../llm'
import type { ConsultPackage, Encounter } from '../record/types'
import { createRunner } from '../agent/runner'
import { AgentError, agentKey, defineTask, publicKey } from '../agent/tasks'
import { budgetLimit, requestTokens } from './budget'
import { fitDraftMaterials } from './materials'
import { draftEncounter, draftMaterialInput, type DraftMaterials, type DraftOptions, type DraftResult } from './index'

// 递归排序对象键；保留数组顺序和字段来源，避免仅 JSON 属性顺序变化就重新起草。
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  return value
}

/** 起草对象是一张问诊卡，而不是“学生今天只能问诊一次”。不同 encounter 各有独立草稿。 */
export async function draftWithAgent(store: LocalStore, pkg: ConsultPackage, materials: DraftMaterials, llm: LlmClient, options: DraftOptions & { now?: Date } = {}): Promise<DraftResult> {
  if (!pkg?.encounter || !/^[a-f0-9]{32}$/.test(pkg.encounter.id) || !publicKey(pkg.encounter.student) || !publicKey(pkg.encounter.teacher)) throw new AgentError('input')
  const level = options.level ?? 'record'
  if (!['record', 'pattern', 'prescription'].includes(level) || (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))) throw new AgentError('input')
  type Generated = Partial<Pick<Encounter, 'fourExams' | 'judgment' | 'plan'>> & { note: string[] }
  const task = defineTask({
    id: 'drafting', side: 'teacher', trigger: { kind: 'manual' }, confirm: 'human',
    gather: async () => ({ pkg, materials }),
    inputKey: async (data: { pkg: ConsultPackage; materials: DraftMaterials }) => {
      const { intake, fourExams, profile } = data.pkg.encounter
      return agentKey([JSON.stringify(canonical({ intake, fourExams, profile }))])
    },
    tokens: (data: { pkg: ConsultPackage; materials: DraftMaterials }) => requestTokens(fitDraftMaterials(draftMaterialInput(data.pkg, data.materials, level)).messages),
    run: async (data): Promise<Generated> => {
      let failed = false
      let failureKind: 'model_account' | 'model_unavailable' = 'model_unavailable'
      const result = await draftEncounter(data.pkg, data.materials, llm, { ...options,
        onError: text => { failed = true; options.onError?.(text) },
        onFailure: kind => { failureKind = kind; options.onFailure?.(kind) },
      })
      if (failed) throw new AgentError(failureKind)
      // 老师已录入的 intake/profile 是只读引用；只有下面这些模型新增字段经过输出守线。
      const { fourExams, judgment, plan } = result.encounter
      const reserved = new Set(data.materials.template.workflow?.record?.sections?.filter((section: { writable_by?: string }) => section.writable_by === 'teacher').map((section: { key: string }) => section.key) ?? [])
      return { ...(!reserved.has('four_exams') ? { fourExams } : {}), ...(!reserved.has('judgment') ? { judgment } : {}), ...(!reserved.has('plan') ? { plan } : {}), note: result.note }
    },
    deliver: async () => {}, // 草稿交给既有核对页；签字发出完全不走执行器。
  })
  const result = await createRunner({ store, side: 'teacher', maxTokens: budgetLimit() }).run(task, { targetId: pkg.encounter.id, now: options.now })
  const { note, ...generated } = result.output
  return { encounter: { ...structuredClone(pkg.encounter), ...generated }, note }
}
