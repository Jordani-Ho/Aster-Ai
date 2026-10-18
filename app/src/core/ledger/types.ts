// 康币账本的纯数据定义。签名与校验复用已批准的 nostr-tools，不自造签名算法。
// 内部 nostr kind：账本事件只作为礼物包裹的内层（rumor）传输，不裸发到中继。
export const LEDGER_EVENT_KIND = 2729
// 参数 P7：扣费后 7 天内可以提异议（含第 7 天）。
export const DISPUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// 记账链只由老师写：充值、赠送、扣费、退款。
export type LedgerEventType = 'topup' | 'gift' | 'charge' | 'refund'
export type ChargeReason = 'consult' | 'herbs' | 'other'

export const EVENT_TYPES: LedgerEventType[] = ['topup', 'gift', 'charge', 'refund']
export const AMOUNT_EVENT_TYPES: LedgerEventType[] = ['topup', 'gift', 'charge', 'refund']
export const CHARGE_REASONS: ChargeReason[] = ['consult', 'herbs', 'other']
export const DISPUTE_TYPE = 'dispute'

// nostr 事件的形状。账本事件与异议都用它，区别是 content 字段不同、异议不进链。
export interface SignedLedgerEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

// 一本账：老师写的记账链 + 学生写的异议列表。异议不进链，避免两个写入者分叉。
export interface Ledger {
  teacher: string
  student: string
  events: SignedLedgerEvent[]
  disputes: SignedLedgerEvent[]
}

// 追加记账事件时由调用方给出的字段；prev、时间与签名由 signEvent 补全。
export interface ChainEventDraft {
  type: LedgerEventType
  at?: string
  amount?: number
  memo?: string
  chargeReason?: ChargeReason
  recordHash?: string
  refundFor?: string
  /** M1-22 一家一本账：这笔扣费记在哪位家人名下（家人称呼）；本人消费省略。 */
  forMember?: string
}

export interface DisputeDraft {
  disputeFor: string
  memo: string
  at?: string
}

// 记账事件真正进入 content 的字段；prev 指向上一条事件的 id（即哈希）。
export interface ChainFields {
  type: LedgerEventType
  at: string
  prev: string | null
  amount?: number
  memo?: string
  chargeReason?: ChargeReason
  recordHash?: string
  refundFor?: string
  forMember?: string
}

// 异议的 content 字段；没有 prev，用 disputeFor 指向扣费事件的 id。
export interface DisputeFields {
  type: typeof DISPUTE_TYPE
  at: string
  disputeFor: string
  memo: string
}

export interface Pricing {
  currency: string
  perCoin: number
}

export interface VerifyIssue {
  part: 'chain' | 'disputes'
  index: number
  code: string
  message: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value)
}

function parseJson(content: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(label + '不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(label + '不是对象')
  return parsed as Record<string, unknown>
}

function parseAt(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('事件时间无效')
  return value
}

export function parseChainFields(event: SignedLedgerEvent): ChainFields {
  const fields = parseJson(event.content, '事件内容')
  if (!EVENT_TYPES.includes(fields.type as LedgerEventType)) throw new Error('事件类型无效')
  parseAt(fields.at)
  if (fields.prev !== null && !isHex64(fields.prev)) throw new Error('上一条事件引用无效')
  if (fields.forMember !== undefined) {
    const member = fields.forMember
    if (typeof member !== 'string' || member.trim() === '' || member.length > 12 || /[\u0000-\u001f\u007f]/.test(member)) throw new Error('家人称呼无效')
  }
  return fields as unknown as ChainFields
}

export function parseDisputeFields(event: SignedLedgerEvent): DisputeFields {
  const fields = parseJson(event.content, '异议内容')
  if (fields.type !== DISPUTE_TYPE) throw new Error('异议类型无效')
  parseAt(fields.at)
  if (!isHex64(fields.disputeFor)) throw new Error('异议目标无效')
  if (typeof fields.memo !== 'string') throw new Error('异议理由无效')
  return fields as unknown as DisputeFields
}
