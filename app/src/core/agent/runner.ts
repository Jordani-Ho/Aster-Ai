import { AgentError, agentKey, defineTask, materialTokens, side, type AgentSide, type AgentStore, type AgentTask } from './tasks'
import { assertAgentOutput, assertJson, sendAgentMessage } from './guard'

export interface RunRequest { targetId: string; now?: Date }
export interface RunResult<O> { key: string; status: 'draft' | 'delivered'; output: O }
interface SavedRun<O> { taskId: string; targetId: string; side: AgentSide; confirm: 'human' | 'template'; localDay: string; at: string; status: 'draft' | 'delivered'; output: O }
let queue: Promise<void> = Promise.resolve()
function day(at: Date): string { return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}` }
export function createRunner(options: {
  store: AgentStore; side: AgentSide; maxTokens: number
  send?: (recipient: string, payload: unknown) => Promise<void>
  allowTemplate?: (taskId: string) => Promise<boolean>
}) {
  side(options.side)
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) throw new AgentError('input')
  const { store } = options
  const execute = <M, O>(task: AgentTask<M, O>, request: RunRequest, confirm: boolean): Promise<RunResult<O>> => {
    const action = async (): Promise<RunResult<O>> => {
      let phase: 'input' | 'storage' | 'delivery' | 'model_unavailable' = 'input'
      try {
        defineTask(task)
        const at = request.now ?? new Date()
        if (task.side !== options.side || typeof request.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.targetId) || !(at instanceof Date) || !Number.isFinite(+at)) throw new AgentError('input')
        const localDay = day(at), key = await agentKey([task.side, task.id, request.targetId, localDay])
        phase = 'storage'
        let row = await store.get('agent-runs', key) as SavedRun<O> | undefined
        if (row) {
          if (row.taskId !== task.id || row.targetId !== request.targetId || row.side !== task.side || row.confirm !== task.confirm || row.localDay !== localDay || !['draft', 'delivered'].includes(row.status)) throw new AgentError('input')
          assertAgentOutput(row.output)
        } else {
          if (confirm) throw new AgentError('input')
          phase = 'model_unavailable'
          const materials = await task.gather()
          assertJson(materials)
          const tokens = task.tokens ? task.tokens(materials) : materialTokens(materials)
          if (!Number.isSafeInteger(tokens) || tokens < 0) throw new AgentError('input')
          if (tokens > options.maxTokens) throw new AgentError('budget')
          const output = await task.run(structuredClone(materials))
          assertAgentOutput(output)
          row = { taskId: task.id, targetId: request.targetId, side: task.side, confirm: task.confirm, localDay, at: at.toISOString(), status: 'draft', output: structuredClone(output) }
          phase = 'storage'
          await store.put('agent-runs', key, row)
        }
        if (row.status === 'draft' && (confirm || task.confirm === 'template')) {
          phase = 'delivery'
          await task.deliver(structuredClone(row.output), { send: async (recipient, payload) => {
            if (task.confirm === 'template' && !await options.allowTemplate?.(task.id)) throw new AgentError('guard', 'template')
            if (!options.send) throw new AgentError('delivery')
            await sendAgentMessage(store, task.side, task.id, recipient, payload, at, options.send)
          } })
          row = { ...row, status: 'delivered' }
          phase = 'storage'
          await store.put('agent-runs', key, row)
        }
        return { key, status: row.status, output: structuredClone(row.output) }
      } catch (error) {
        const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : null
        const kind = error instanceof AgentError ? error.kind : status === 401 || status === 402 || status === 429 ? 'model_account' : phase
        try {
          await store.put('agent-failures', crypto.randomUUID(), { at: new Date().toISOString(), kind })
          const rows = await store.list('agent-failures')
          rows.sort((a, b) => String((a.value as { at?: unknown })?.at).localeCompare(String((b.value as { at?: unknown })?.at)))
          for (const row of rows.slice(0, Math.max(0, rows.length - 100))) await store.delete('agent-failures', row.key)
        } catch { /* 日志失败不覆盖原类别。 */ }
        throw new AgentError(kind, error instanceof AgentError ? error.reason : undefined)
      }
    }
    // 同页所有执行器共用队列；支持 Web Locks 的浏览器同时防住多标签页。
    const result = queue.then(() => globalThis.navigator?.locks
      ? navigator.locks.request('aster-agent-run', action) : action())
    queue = result.then(() => {}, () => {})
    return result
  }
  return {
    run: <M, O>(task: AgentTask<M, O>, request: RunRequest) => execute(task, request, false),
    /** 仅供真人点击入口调用；不在 run() 中替 human 任务调用。 */
    confirm: <M, O>(task: AgentTask<M, O>, request: RunRequest) => execute(task, request, true),
  }
}
