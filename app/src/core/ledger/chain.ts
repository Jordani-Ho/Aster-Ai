import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import {
  AMOUNT_EVENT_TYPES,
  EVENT_TYPES,
  isHex64,
  LEDGER_EVENT_KIND,
  parseFields,
  type Ledger,
  type LedgerEventDraft,
  type LedgerFields,
  type Pricing,
  type SignedLedgerEvent,
} from './types'

const OPTIONAL_FIELDS = ['amount', 'memo', 'chargeReason', 'recordHash', 'refundFor', 'disputeFor'] as const

export function createLedger(teacher: string, student: string): Ledger {
  if (!isHex64(teacher) || !isHex64(student)) throw new Error('老师或学生公钥格式无效')
  return { teacher, student, events: [] }
}

// 给草稿补上 prev（上一条事件的 id）、时间，并用 privateKey 做 Schnorr 签名。
// 这里不校验账本业务规则；业务规则由 verify 统一检查。
export function signEvent(ledger: Ledger, privateKey: Uint8Array, draft: LedgerEventDraft): SignedLedgerEvent {
  if (!EVENT_TYPES.includes(draft.type)) throw new Error('事件类型无效')
  const at = draft.at ?? new Date().toISOString()
  const atMs = Date.parse(at)
  if (!Number.isFinite(atMs)) throw new Error('事件时间无效')
  const fields: LedgerFields = {
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

// 正常记账入口：先检查签发人身份（充值/赠送/扣费/退款只能老师签，异议只能学生签），再签名。
export function append(ledger: Ledger, privateKey: Uint8Array, draft: LedgerEventDraft): Ledger {
  const issuer = getPublicKey(privateKey)
  const expected = draft.type === 'dispute' ? ledger.student : ledger.teacher
  if (issuer !== expected) throw new Error(draft.type + ' 只能由' + (draft.type === 'dispute' ? '学生' : '老师') + '签发')
  return { ...ledger, events: [...ledger.events, signEvent(ledger, privateKey, draft)] }
}

function amountOf(fields: LedgerFields): number {
  if (typeof fields.amount !== 'number' || !Number.isSafeInteger(fields.amount) || fields.amount <= 0) throw new Error('账本事件金额无效：必须是正整数')
  return fields.amount
}

// 余额 = 充值 + 赠送 − 扣费 − 退款；异议不影响余额，允许为负。
export function balance(ledger: Ledger): number {
  let total = 0
  for (const event of ledger.events) {
    const fields = parseFields(event)
    if (!AMOUNT_EVENT_TYPES.includes(fields.type)) continue
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
    const fields = parseFields(event)
    if (AMOUNT_EVENT_TYPES.includes(fields.type)) {
      const amount = amountOf(fields)
      total += fields.type === 'topup' || fields.type === 'gift' ? amount : -amount
    }
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
