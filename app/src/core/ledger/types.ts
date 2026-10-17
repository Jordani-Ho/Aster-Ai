// 康币账本的纯数据定义。签名与校验复用已批准的 nostr-tools，不自造签名算法。
export const LEDGER_EVENT_KIND = 2729
// 参数 P7：扣费后 7 天内可以提异议（含第 7 天）。
export const DISPUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export type LedgerEventType = 'topup' | 'gift' | 'charge' | 'refund' | 'dispute'
export type ChargeReason = 'consult' | 'herbs' | 'other'

export const EVENT_TYPES: LedgerEventType[] = ['topup', 'gift', 'charge', 'refund', 'dispute']
export const AMOUNT_EVENT_TYPES: LedgerEventType[] = ['topup', 'gift', 'charge', 'refund']
export const CHARGE_REASONS: ChargeReason[] = ['consult', 'herbs', 'other']

// nostr 事件的形状；账本事件就是一条 kind 2729 的签名事件，content 是账本字段的 JSON。
export interface SignedLedgerEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface Ledger {
  teacher: string
  student: string
  events: SignedLedgerEvent[]
}

// 追加事件时由调用方给出的字段；prev、时间与签名由 signEvent 补全。
export interface LedgerEventDraft {
  type: LedgerEventType
  at?: string
  amount?: number
  memo?: string
  chargeReason?: ChargeReason
  recordHash?: string
  refundFor?: string
  disputeFor?: string
}

// 签名后真正进入 content 的字段；prev 指向上一条事件的 id（即哈希）。
export interface LedgerFields {
  type: LedgerEventType
  at: string
  prev: string | null
  amount?: number
  memo?: string
  chargeReason?: ChargeReason
  recordHash?: string
  refundFor?: string
  disputeFor?: string
}

export interface Pricing {
  currency: string
  perCoin: number
}

export interface VerifyIssue {
  index: number
  code: string
  message: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value)
}

export function parseFields(event: SignedLedgerEvent): LedgerFields {
  let parsed: unknown
  try {
    parsed = JSON.parse(event.content)
  } catch {
    throw new Error('事件内容不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('事件内容不是对象')
  const fields = parsed as LedgerFields
  if (!EVENT_TYPES.includes(fields.type)) throw new Error('事件类型无效')
  if (typeof fields.at !== 'string' || !Number.isFinite(Date.parse(fields.at))) throw new Error('事件时间无效')
  if (fields.prev !== null && !isHex64(fields.prev)) throw new Error('上一条事件引用无效')
  return fields
}
