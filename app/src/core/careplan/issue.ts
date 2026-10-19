import type { Identity } from '../identity'
import type { LocalStore } from '../store'
import type { Envelope } from '../transport'
import { signCarePlan, sendCarePlan, storeCarePlan, verifySignedCarePlan, type CarePlan, type SignedCarePlanEvent } from './index'
import { sendStorefrontTo } from '../storefront'

export type CarePlanDraft = Pick<CarePlan, 'constitution' | 'points' | 'avoid'> & { source: 'ai_draft' }
type Send = (student: string, envelope: Envelope) => Promise<unknown>
interface Pending { student: string; event: SignedCarePlanEvent }
interface Issued { student: string; version: number; eventId: string }
export class PlanUndeliveredError extends Error {
  constructor(readonly pendingKey: string) { super('方案未发出，资料已保留，可重发。') }
}
// 签发路径只组合 M1-18 的签名、信封与存储函数；不导入或调用模型。
export async function pendingCarePlan(store: LocalStore, identity: Identity, student: string) {
  for (const row of await store.list('care-plan-pending')) {
    const value = row.value as unknown as Pending
    if (value.student !== student) continue
    const plan = verifySignedCarePlan(value.event, { student, teacher: identity.publicKey })
    return { key: row.key, plan }
  }
  return null
}
export async function retryCarePlan(options: { identity: Identity; store: LocalStore; pendingKey: string; send?: Send }): Promise<CarePlan> {
  const { identity, store, pendingKey, send } = options
  const value = await store.get('care-plan-pending', pendingKey) as unknown as Pending | undefined
  if (!value) throw Error('未找到待发方案')
  const plan = verifySignedCarePlan(value.event, { student: value.student, teacher: identity.publicKey })
  try {
    if (value.student === identity.publicKey) await storeCarePlan(store, identity.publicKey, plan)
    else {
      if (!send) throw Error('offline')
      await sendCarePlan(send, value.student, value.event)
      // V2-09：签发调养方案时顺带发一次老师当前门面；门面不是签发条件，失败不影响方案。
      try { await sendStorefrontTo({ store, identity, recipients: [value.student], send }) } catch { /* 门面下次同步再说 */ }
    }
    const rows = await store.list('care-plan-issued')
    const row = rows.find(item => (item.value as unknown as Issued).student === value.student)
    const previous = row?.value as unknown as Issued | undefined
    if (!previous || previous.version < plan.version) {
      await store.put('care-plan-issued', row?.key ?? crypto.randomUUID(), { student: value.student, version: plan.version, eventId: value.event.id })
    }
    await store.delete('care-plan-pending', pendingKey)
    return plan
  } catch { throw new PlanUndeliveredError(pendingKey) }
}
export async function issueCarePlan(options: { identity: Identity; store: LocalStore; student: string; draft: CarePlanDraft; send?: Send; now?: () => Date }): Promise<CarePlan> {
  const { identity, store, student, draft } = options
  const pending = await pendingCarePlan(store, identity, student)
  if (pending) return retryCarePlan({ ...options, pendingKey: pending.key })
  const issued = (await store.list('care-plan-issued')).map(row => row.value as unknown as Issued).find(row => row.student === student)
  const plan: CarePlan = { constitution: draft.constitution, points: [...draft.points], avoid: [...draft.avoid], version: (issued?.version ?? 0) + 1, updatedAt: (options.now?.() ?? new Date()).toISOString() }
  const event = signCarePlan(plan, student, identity.privateKey)
  const pendingKey = crypto.randomUUID()
  await store.put('care-plan-pending', pendingKey, { student, event: JSON.parse(JSON.stringify(event)) })
  return retryCarePlan({ ...options, pendingKey })
}
