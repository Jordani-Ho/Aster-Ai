import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import {
  EVENT_TYPES,
  isHex64,
  LEDGER_EVENT_KIND,
  parseChainFields,
  type ChainEventDraft,
  type ChainFields,
  type DisputeDraft,
  type Ledger,
  type Pricing,
  type SignedLedgerEvent,
} from './types'

const OPTIONAL_FIELDS = ['amount', 'memo', 'chargeReason', 'recordHash', 'refundFor', 'forMember'] as const

function draftTime(at?: string): { at: string; atMs: number } {
  const value = at ?? new Date().toISOString()
  const atMs = Date.parse(value)
  if (!Number.isFinite(atMs)) throw new Error('事件时间无效')
  return { at: value, atMs }
}

export function createLedger(teacher: string, student: string): Ledger {
  if (!isHex64(teacher) || !isHex64(student)) throw new Error('老师或学生公钥格式无效')
  return { teacher, student, events: [], disputes: [] }
}

// 给记账草稿补上 prev、时间并签名。这里不校验签发人，签发人由 append 与 verify 检查。
export function signEvent(ledger: Ledger, privateKey: Uint8Array, draft: ChainEventDraft): SignedLedgerEvent {
  if (!EVENT_TYPES.includes(draft.type)) throw new Error('记账事件类型无效（异议请用 signDispute）')
  const { at, atMs } = draftTime(draft.at)
  const fields: ChainFields = {
    type: draft.type,
    at,
    prev: ledger.events.length === 0 ? null : ledger.events[ledger.events.length - 1].id,
  }
  for (const field of OPTIONAL_FIELDS) {
    if (draft[field] !== undefined) fields[field] = draft[field] as never
  }
  const event = finalizeEvent({
    kind: LEDGER_EVENT_KIND,
    created_at: Math.floor(atMs / 1000),
    tags: [['ledger', ledger.teacher, ledger.student]],
    content: JSON.stringify(fields),
  }, privateKey)
  return event as SignedLedgerEvent
}

// 正常记账入口：记账链只有一个写入者，只能是老师。
export function append(ledger: Ledger, privateKey: Uint8Array, draft: ChainEventDraft): Ledger {
  if (getPublicKey(privateKey) !== ledger.teacher) throw new Error('记账链只能由老师写入')
  return { ...ledger, events: [...ledger.events, signEvent(ledger, privateKey, draft)] }
}

// 给异议签名。异议不进链，没有 prev，用 disputeFor 指向扣费事件的 id。
export function signDispute(ledger: Ledger, privateKey: Uint8Array, draft: DisputeDraft): SignedLedgerEvent {
  if (!isHex64(draft.disputeFor)) throw new Error('异议目标格式无效')
  if (typeof draft.memo !== 'string' || draft.memo.trim() === '') throw new Error('异议必须写一句话理由')
  const { at, atMs } = draftTime(draft.at)
  const event = finalizeEvent({
    kind: LEDGER_EVENT_KIND,
    created_at: Math.floor(atMs / 1000),
    tags: [['ledger', ledger.teacher, ledger.student]],
    content: JSON.stringify({ type: 'dispute', at, disputeFor: draft.disputeFor, memo: draft.memo }),
  }, privateKey)
  return event as SignedLedgerEvent
}

// 正常提异议入口：只有学生能签，且必须针对链里已经存在的一条扣费。
export function appendDispute(ledger: Ledger, privateKey: Uint8Array, draft: DisputeDraft): Ledger {
  if (getPublicKey(privateKey) !== ledger.student) throw new Error('异议只能由学生签发')
  const target = ledger.events.find(event => event.id === draft.disputeFor)
  if (!target) throw new Error('异议必须针对链里已经存在的扣费事件')
  if (parseChainFields(target).type !== 'charge') throw new Error('异议只能针对扣费事件')
  return { ...ledger, disputes: [...ledger.disputes, signDispute(ledger, privateKey, draft)] }
}

function amountOf(fields: ChainFields): number {
  if (typeof fields.amount !== 'number' || !Number.isSafeInteger(fields.amount) || fields.amount <= 0) throw new Error('账本事件金额无效：必须是正整数')
  return fields.amount
}

// 余额 = 充值 + 赠送 − 扣费 − 退款；异议不影响余额，允许为负。
export function balance(ledger: Ledger): number {
  let total = 0
  for (const event of ledger.events) {
    const fields = parseChainFields(event)
    const amount = amountOf(fields)
    total += fields.type === 'topup' || fields.type === 'gift' ? amount : -amount
  }
  return total
}

// 余额从某个时间点起一直是负数，返回那段连续欠费的起始时间；账本末尾余额不为负时返回 null。
export function overdueSince(ledger: Ledger): string | null {
  let total = 0
  let since: string | null = null
  for (const event of ledger.events) {
    const fields = parseChainFields(event)
    const amount = amountOf(fields)
    total += fields.type === 'topup' || fields.type === 'gift' ? amount : -amount
    if (total < 0) {
      if (since === null) since = fields.at
    } else {
      since = null
    }
  }
  return since
}

// 老师资料里的计价声明，只写“1 康币相当于多少钱”；账本本身只记整数康币。
export function declarePricing(pricing: Pricing): Pricing {
  if (typeof pricing !== 'object' || pricing === null) throw new Error('计价声明格式无效')
  if (!/^[A-Z]{3}$/.test(pricing.currency)) throw new Error('币种必须是三位大写字母代码')
  if (!Number.isFinite(pricing.perCoin) || pricing.perCoin <= 0) throw new Error('每康币价格必须是正数')
  return { currency: pricing.currency, perCoin: pricing.perCoin }
}
