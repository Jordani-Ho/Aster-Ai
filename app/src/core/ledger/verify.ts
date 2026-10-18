import { getEventHash, verifyEvent } from 'nostr-tools/pure'
import {
  AMOUNT_EVENT_TYPES,
  CHARGE_REASONS,
  DISPUTE_WINDOW_MS,
  isHex64,
  LEDGER_EVENT_KIND,
  parseChainFields,
  parseDisputeFields,
  type ChainFields,
  type Ledger,
  type SignedLedgerEvent,
  type VerifyIssue,
} from './types'

type Part = VerifyIssue['part']

// nostr-tools 的 verifyEvent 会把“已验证”缓存在事件对象上；先重算事件 id，确认 content 与 id 绑定。
function signatureValid(event: SignedLedgerEvent): boolean {
  try {
    if (getEventHash(event) !== event.id) return false
    // 逐字段重建，不能展开复制输入上的 verified Symbol；sig 不参与 id 哈希。
    return verifyEvent({
      id: event.id, pubkey: event.pubkey, created_at: event.created_at,
      kind: event.kind, tags: event.tags.map(tag => [...tag]), content: event.content, sig: event.sig,
    })
  } catch {
    return false
  }
}

function tagsBound(event: SignedLedgerEvent, teacher: string, student: string): boolean {
  return Array.isArray(event.tags) && event.tags.some(tag =>
    Array.isArray(tag) && tag[0] === 'ledger' && tag[1] === teacher && tag[2] === student)
}

// 分别校验两部分：老师写的记账链，和学生写的异议列表。返回所有问题及其位置。
export function verify(ledger: Ledger): VerifyIssue[] {
  const issues: VerifyIssue[] = []
  const report = (part: Part, index: number, code: string, message: string) => issues.push({ part, index, code, message })
  if (!isHex64(ledger.teacher) || !isHex64(ledger.student)) report('chain', -1, 'invalid-ledger', '老师或学生公钥格式无效')

  const chainEvents = new Map<string, { index: number; fields: ChainFields }>()
  let previousAt: number | null = null
  let cumulativeTopups = 0
  let cumulativeRefunds = 0

  for (let index = 0; index < ledger.events.length; index++) {
    const event = ledger.events[index]
    if (event.kind !== LEDGER_EVENT_KIND) report('chain', index, 'wrong-kind', '事件 kind 不是账本事件')
    if (!signatureValid(event)) report('chain', index, 'bad-signature', '事件内容与 id 不一致，或签名校验失败')
    let fields: ChainFields
    try {
      fields = parseChainFields(event)
    } catch (cause) {
      report('chain', index, 'invalid-content', cause instanceof Error ? cause.message : '事件内容无效')
      continue
    }
    if (!tagsBound(event, ledger.teacher, ledger.student)) report('chain', index, 'wrong-tags', '事件没有绑定这本账的师生公钥')
    if (event.pubkey !== ledger.teacher) report('chain', index, 'wrong-issuer', '记账事件只能由老师签发')

    const expectedPrev = index === 0 ? null : ledger.events[index - 1].id
    if (fields.prev !== expectedPrev) report('chain', index, 'broken-chain', '上一条事件引用不连续')

    const at = Date.parse(fields.at)
    if (previousAt !== null && at < previousAt) report('chain', index, 'time-regressed', '事件时间倒退')
    if (event.created_at !== Math.floor(at / 1000)) report('chain', index, 'created-at-mismatch', '事件时间与 created_at 不一致')
    previousAt = at

    if (!AMOUNT_EVENT_TYPES.includes(fields.type)) {
      report('chain', index, 'invalid-amount', '记账事件类型无效')
    } else if (typeof fields.amount !== 'number' || !Number.isSafeInteger(fields.amount) || fields.amount <= 0) {
      report('chain', index, 'invalid-amount', '金额必须是正整数')
    } else if (fields.type === 'topup') {
      cumulativeTopups += fields.amount
    }

    if (fields.type === 'charge') {
      if (fields.chargeReason === undefined || !CHARGE_REASONS.includes(fields.chargeReason)) report('chain', index, 'invalid-reason', '扣费事由无效')
      if (fields.recordHash !== undefined && !isHex64(fields.recordHash)) report('chain', index, 'invalid-record-hash', '关联记录哈希格式无效')
    }

    // M1-22：只有扣费可以标注“记在哪位家人名下”。
    if (fields.forMember !== undefined && fields.type !== 'charge') report('chain', index, 'invalid-member', '只有扣费事件可以标注家人称呼')

    if (fields.type === 'refund') {
      if (fields.refundFor !== undefined && !chainEvents.has(fields.refundFor)) report('chain', index, 'unknown-refund-target', '退款指向的事件不存在或不在之前')
      if (typeof fields.amount === 'number' && Number.isSafeInteger(fields.amount) && fields.amount > 0) {
        // L2：退款金额不得超过“累计充值 − 累计退款”。
        if (fields.amount > cumulativeTopups - cumulativeRefunds) report('chain', index, 'refund-exceeds-topups', '退款超过累计充值减累计退款（L2）')
        cumulativeRefunds += fields.amount
      }
    }

    chainEvents.set(event.id, { index, fields })
  }

  for (let index = 0; index < ledger.disputes.length; index++) {
    const event = ledger.disputes[index]
    if (event.kind !== LEDGER_EVENT_KIND) report('disputes', index, 'wrong-kind', '事件 kind 不是账本事件')
    if (!signatureValid(event)) report('disputes', index, 'bad-signature', '事件内容与 id 不一致，或签名校验失败')
    let fields
    try {
      fields = parseDisputeFields(event)
    } catch (cause) {
      report('disputes', index, 'invalid-content', cause instanceof Error ? cause.message : '异议内容无效')
      continue
    }
    if (!tagsBound(event, ledger.teacher, ledger.student)) report('disputes', index, 'wrong-tags', '异议没有绑定这本账的师生公钥')
    if (event.pubkey !== ledger.student) report('disputes', index, 'wrong-issuer', '异议只能由学生签发')

    const at = Date.parse(fields.at)
    if (event.created_at !== Math.floor(at / 1000)) report('disputes', index, 'created-at-mismatch', '异议时间与 created_at 不一致')
    if (fields.memo.trim() === '') report('disputes', index, 'missing-reason', '异议必须写一句话理由')

    const target = chainEvents.get(fields.disputeFor)
    if (!target || target.fields.type !== 'charge') {
      report('disputes', index, 'unknown-dispute-target', '异议必须针对链里存在的一条扣费')
      continue
    }
    const targetAt = Date.parse(target.fields.at)
    if (at < targetAt) {
      report('disputes', index, 'dispute-too-early', '异议时间早于所针对的扣费')
    } else if (at - targetAt > DISPUTE_WINDOW_MS) {
      report('disputes', index, 'dispute-too-late', '异议超过扣费后 7 天（P7，按事件自报时间）')
    }
  }

  return issues
}
