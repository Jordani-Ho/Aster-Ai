export type AgentSide = 'teacher' | 'student'
export type AgentTrigger = { kind: 'open' | 'manual' } | { kind: 'time'; hour: number } | { kind: 'message'; type: string }
export interface AgentStore {
  get(collection: string, key: string): Promise<unknown>
  put(collection: string, key: string, value: any): Promise<void>
  list(collection: string): Promise<{ key: string; value: unknown }[]>
  delete(collection: string, key: string): Promise<void>
}
export interface DeliveryContext { send(recipient: string, payload: unknown): Promise<void> }
export interface AgentTask<M, O> {
  id: string
  side: AgentSide
  trigger: AgentTrigger
  confirm: 'human' | 'template'
  gather(): Promise<M>
  run(materials: M): Promise<O>
  deliver(output: O, context: DeliveryContext): Promise<void>
  /** 领域适配器可按实际请求估算；未提供时估算全部 JSON 材料。 */
  tokens?(materials: M): number
}
export class AgentError extends Error {
  constructor(public readonly kind: 'input' | 'budget' | 'guard' | 'model_account' | 'model_unavailable' | 'delivery' | 'storage', public readonly reason?: 'relationship' | 'cooldown' | 'template') {
    const reasons = { relationship: '不能向没有师生关系的人发消息', cooldown: '同一任务发给同一人，须至少间隔一个时辰', template: '基础模板尚未允许自动发出' }
    super(reason ? reasons[reason] : { input: '任务输入无效', budget: '本次材料超出额度，请精简材料', guard: '智能体守线校验未通过', model_account: '模型账户需要检查', model_unavailable: '任务执行暂未成功，请重试', delivery: '任务发出暂未成功，草稿仍在本机', storage: '任务没有保存成功，请重试' }[kind])
  }
}
export const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
export const publicKey = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function side(value: unknown): asserts value is AgentSide {
  if (value !== 'teacher' && value !== 'student') throw new AgentError('input')
}
export function defineTask<M, O>(task: AgentTask<M, O>): AgentTask<M, O> {
  if (!task || !identifier(task.id)) throw new AgentError('input')
  side(task.side)
  if (!['human', 'template'].includes(task.confirm) || !task.trigger || typeof task.trigger !== 'object') throw new AgentError('input')
  const trigger = task.trigger
  if (!['open', 'manual', 'time', 'message'].includes(trigger.kind)) throw new AgentError('input')
  if (trigger.kind === 'time' && (!Number.isInteger(trigger.hour) || trigger.hour < 0 || trigger.hour > 23)) throw new AgentError('input')
  if (trigger.kind === 'message' && (typeof trigger.type !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(trigger.type))) throw new AgentError('input')
  if (['gather', 'run', 'deliver'].some(key => typeof task[key as 'run'] !== 'function') || (task.tokens !== undefined && typeof task.tokens !== 'function')) throw new AgentError('input')
  return Object.freeze({ ...task, trigger: Object.freeze({ ...trigger }) })
}
/** 与 V2-19 相同的保守字符估算；核心不依赖任何领域数值。 */
export function materialTokens(value: unknown): number {
  const text = JSON.stringify(value)
  let units = 0
  for (const char of text) units += /\p{Script=Han}/u.test(char) ? 3 : 1
  return Math.ceil(units / 3)
}
export async function agentKey(parts: readonly string[]): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('')
}
