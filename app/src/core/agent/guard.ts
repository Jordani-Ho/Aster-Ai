import { AgentError, agentKey, identifier, publicKey, side, type AgentSide, type AgentStore } from './tasks'

export function assertJson(value: unknown, forbidTeacher = false): void {
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number) => {
    if (depth > 64) throw new AgentError('input')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || seen.has(item)) throw new AgentError('input')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new AgentError('input')
    if (Reflect.ownKeys(item).some(key => typeof key === 'symbol')) throw new AgentError('input')
    if (forbidTeacher && (item as { source?: unknown }).source === 'teacher') throw new AgentError('guard')
    seen.add(item)
    for (const entry of Object.values(item)) visit(entry, depth + 1)
    seen.delete(item)
  }
  visit(value, 0)
}
export function assertAgentOutput(value: unknown): void { assertJson(value, true) }

// 发送单独串行，不能复用执行器的锁（deliver 会在执行器锁内调用它）。
let sending: Promise<void> = Promise.resolve()
export function sendAgentMessage(store: AgentStore, agentSide: AgentSide, taskId: string, recipient: string, payload: unknown, at: Date, send: (recipient: string, payload: unknown) => Promise<void>): Promise<void> {
  const action = async () => {
    side(agentSide)
    if (!identifier(taskId) || !publicKey(recipient) || !(at instanceof Date) || !Number.isFinite(+at) || typeof send !== 'function') throw new AgentError('input')
    assertAgentOutput(payload)
    const teachers = agentSide === 'student' ? await store.get('settings', 'teachers') : undefined
    const relation = agentSide === 'teacher'
      ? (await store.get('teacher-students', recipient) as { student?: unknown } | undefined)?.student === recipient
      : Array.isArray(teachers) && teachers.includes(recipient)
    if (!relation) throw new AgentError('guard', 'relationship')
    const key = await agentKey([agentSide, taskId, recipient])
    const previous = await store.get('agent-sent', key)
    if (previous !== undefined && (typeof previous !== 'number' || !Number.isFinite(previous) || +at - previous < 2 * 60 * 60 * 1000)) throw new AgentError('guard', 'cooldown')
    // 先落下发送尝试，失败也不连发；传递层可能已接收后才断线，不能当成未发送。
    await store.put('agent-sent', key, +at)
    await send(recipient, structuredClone(payload))
  }
  const result = sending.then(() => globalThis.navigator?.locks
    ? navigator.locks.request('aster-agent-send', action) : action())
  sending = result.then(() => {}, () => {})
  return result
}
