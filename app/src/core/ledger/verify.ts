import { getEventHash, verifyEvent } from 'nostr-tools/pure'
import {
  AMOUNT_EVENT_TYPES,
  CHARGE_REASONS,
  DISPUTE_WINDOW_MS,
  isHex64,
  LEDGER_EVENT_KIND,
  parseFields,
  type Ledger,
  type LedgerFields,
  type VerifyIssue,
} from './types'

// 逐条检查签名、签发人、哈希链、金额、时间与 C 类规则；返回所有发现的问题和位置。
export function verify(ledger: Ledger): VerifyIssue[] {
  const issues: VerifyIssue[] = []
  const report = (index: number, code: string, message: string) => issues.push({ index, code, message })
  if (!isHex64(ledger.teacher) || !isHex64(ledger.student)) report(-1, 'invalid-ledger', '老师或学生公钥格式无效')

  // 之前出现过的事件，按 id 建立索引，供退款/异议引用检查。
  const previousEvents = new Map<string, { index: number; fields: LedgerFields }>()
  let previousAt: number | null = null
  let cumulativeTopups = 0
  let cumulativeRefunds = 0

  for (let index = 0; index < ledger.events.length; index++) {
    const event = ledger.events[index]
    if (event.kind !== LEDGER_EVENT_KIND) report(index, 'wrong-kind', '事件 kind 不是账本事件')
    // nostr-tools 会在事件对象上缓存“已验证”，展开复制会把这个缓存一起带过去；
    // 所以先自己重算事件 id，确认 content 与 id 绑定，再验签名。
    let idMatches = false
    try {
      idMatches = getEventHash(event) === event.id
      if (!idMatches) report(index, 'bad-signature', '事件内容与 id 不一致，可能被篡改')
      else if (!verifyEvent(event)) report(index, 'bad-signature', '签名或事件 id 校验失败')
    } catch {
      report(index, 'bad-signature', '签名或事件 id 校验失败')
    }
    let fields: LedgerFields
    try {
      fields = parseFields(event)
    } catch (cause) {
      report(index, 'invalid-content', cause instanceof Error ? cause.message : '事件内容无效')
      continue
    }

    const tagsBound = Array.isArray(event.tags) && event.tags.some(tag => Array.isArray(tag) && tag[0] === 'ledger' && tag[1] === ledger.teacher && tag[2] === ledger.student)
    if (!tagsBound) report(index, 'wrong-tags', '事件没有绑定这本账的师生公钥')

    const expectedIssuer = fields.type === 'dispute' ? ledger.student : ledger.teacher
    if (event.pubkey !== expectedIssuer) report(index, 'wrong-issuer', fields.type + ' 的签发人与事件类型不符')

    const expectedPrev = index === 0 ? null : ledger.events[index - 1].id
    if (fields.prev !== expectedPrev) report(index, 'broken-chain', '上一条事件引用不连续')

    const at = Date.parse(fields.at)
    if (previousAt !== null && at < previousAt) report(index, 'time-regressed', '事件时间倒退')
    if (event.created_at !== Math.floor(at / 1000)) report(index, 'created-at-mismatch', '事件时间与 created_at 不一致')
    previousAt = at

    if (AMOUNT_EVENT_TYPES.includes(fields.type)) {
      if (typeof fields.amount !== 'number' || !Number.isSafeInteger(fields.amount) || fields.amount <= 0) {
        report(index, 'invalid-amount', '金额必须是正整数')
      } else if (fields.type === 'topup') {
        cumulativeTopups += fields.amount
      }
    } else if (fields.amount !== undefined) {
      report(index, 'invalid-amount', '异议事件不应带金额')
    }

    if (fields.type === 'charge') {
      if (fields.chargeReason === undefined || !CHARGE_REASONS.includes(fields.chargeReason)) report(index, 'invalid-reason', '扣费事由无效')
      if (fields.recordHash !== undefined && !isHex64(fields.recordHash)) report(index, 'invalid-record-hash', '关联记录哈希格式无效')
    }

    if (fields.type === 'refund' && typeof fields.amount === 'number' && Number.isSafeInteger(fields.amount) && fields.amount > 0) {
      if (fields.refundFor !== undefined && !previousEvents.has(fields.refundFor)) report(index, 'unknown-refund-target', '退款指向的事件不存在或不在之前')
      // L2：退款金额不得超过“累计充值 − 累计退款”。
      if (fields.amount > cumulativeTopups - cumulativeRefunds) report(index, 'refund-exceeds-topups', '退款超过累计充值减累计退款（L2）')
      cumulativeRefunds += fields.amount
    }

    if (fields.type === 'dispute') {
      const target = fields.disputeFor === undefined ? undefined : previousEvents.get(fields.disputeFor)
      if (!target || target.fields.type !== 'charge') {
        report(index, 'unknown-dispute-target', '异议必须针对之前的一条扣费')
      } else if (at - Date.parse(target.fields.at) > DISPUTE_WINDOW_MS) {
        report(index, 'dispute-too-late', '异议超过扣费后 7 天（P7）')
      }
      if (typeof fields.memo !== 'string' || fields.memo.trim() === '') report(index, 'missing-reason', '异议必须写一句话理由')
    }

    previousEvents.set(event.id, { index, fields })
  }

  return issues
}
