import { describe, expect, it } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  append,
  appendDispute,
  balance,
  createLedger,
  declarePricing,
  overdueSince,
  signDispute,
  signEvent,
  verify,
  type Ledger,
} from './index'

const DAY = 24 * 60 * 60 * 1000
// 合成时间轴：2026-01-01 起第 n 天（UTC）。
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * DAY).toISOString()

// 合成密钥，运行时生成，不对应任何真实身份。
const teacherKey = generateSecretKey()
const teacher = getPublicKey(teacherKey)
const studentKey = generateSecretKey()
const student = getPublicKey(studentKey)

function emptyLedger(): Ledger {
  return createLedger(teacher, student)
}

function tamperChain(ledger: Ledger, index: number, change: (fields: Record<string, unknown>) => void): Ledger {
  const events = ledger.events.map((event, position) => {
    if (position !== index) return event
    const fields = JSON.parse(event.content) as Record<string, unknown>
    change(fields)
    return { ...event, content: JSON.stringify(fields) }
  })
  return { ...ledger, events }
}

describe('M1-14a 康币账本核心验收', () => {
  it('1 依次记充值 100、赠送 20、扣费 50、退款 10，余额为 60；两次计算一致', () => {
    let ledger = emptyLedger()
    ledger = append(ledger, teacherKey, { type: 'topup', amount: 100, memo: '合成充值', at: day(1) })
    ledger = append(ledger, teacherKey, { type: 'gift', amount: 20, memo: '合成赠送', at: day(1) })
    ledger = append(ledger, teacherKey, { type: 'charge', amount: 50, chargeReason: 'consult', at: day(2) })
    ledger = append(ledger, teacherKey, { type: 'refund', amount: 10, refundFor: ledger.events[0].id, at: day(3) })
    expect(balance(ledger)).toBe(60)
    expect(balance(ledger)).toBe(60)
    expect(verify(ledger)).toEqual([])
  })

  it('2 改动金额或删掉链里中间一条，verify 都报出位置；改异议内容也能发现', () => {
    let ledger = emptyLedger()
    ledger = append(ledger, teacherKey, { type: 'topup', amount: 100, at: day(1) })
    ledger = append(ledger, teacherKey, { type: 'gift', amount: 20, at: day(1) })
    ledger = append(ledger, teacherKey, { type: 'charge', amount: 50, chargeReason: 'consult', at: day(2) })
    ledger = appendDispute(ledger, studentKey, { disputeFor: ledger.events[2].id, memo: '合成异议', at: day(3) })

    const amountIssues = verify(tamperChain(ledger, 1, fields => { fields.amount = 200 }))
    expect(amountIssues.some(issue => issue.part === 'chain' && issue.index === 1)).toBe(true)
    expect(amountIssues.some(issue => issue.code === 'bad-signature')).toBe(true)

    const removed = { ...ledger, events: ledger.events.filter((_, index) => index !== 1) }
    const removalIssues = verify(removed)
    expect(removalIssues.some(issue => issue.part === 'chain' && issue.index === 1)).toBe(true)
    expect(removalIssues.some(issue => issue.code === 'broken-chain')).toBe(true)

    const disputes = ledger.disputes.map(event => ({ ...event, content: event.content.replace('合成异议', '改过的异议') }))
    const disputeIssues = verify({ ...ledger, disputes })
    expect(disputeIssues.some(issue => issue.part === 'disputes' && issue.index === 0 && issue.code === 'bad-signature')).toBe(true)
  })

  it('3 学生签的 charge、老师签的 dispute 都校验不通过；append 入口也拒绝', () => {
    const wrongCharge = signEvent(emptyLedger(), studentKey, { type: 'charge', amount: 10, chargeReason: 'consult', at: day(1) })
    const chargeLedger: Ledger = { ...emptyLedger(), events: [wrongCharge] }
    expect(verify(chargeLedger).some(issue => issue.part === 'chain' && issue.code === 'wrong-issuer' && issue.index === 0)).toBe(true)

    const wrongDispute = signDispute(emptyLedger(), teacherKey, { disputeFor: 'a'.repeat(64), memo: '合成理由', at: day(1) })
    const disputeLedger: Ledger = { ...emptyLedger(), disputes: [wrongDispute] }
    expect(verify(disputeLedger).some(issue => issue.part === 'disputes' && issue.code === 'wrong-issuer' && issue.index === 0)).toBe(true)

    expect(() => append(emptyLedger(), studentKey, { type: 'charge', amount: 10, chargeReason: 'consult', at: day(1) })).toThrow()
    expect(() => appendDispute(emptyLedger(), teacherKey, { disputeFor: 'a'.repeat(64), memo: '合成理由', at: day(1) })).toThrow()
  })

  it('4 扣费后第 7 天的异议通过，第 8 天的不通过', () => {
    let ledger = emptyLedger()
    ledger = append(ledger, teacherKey, { type: 'charge', amount: 10, chargeReason: 'consult', at: day(1) })
    const charge = ledger.events[0]

    const onDay7 = appendDispute(ledger, studentKey, {
      disputeFor: charge.id,
      memo: '合成异议理由',
      at: new Date(Date.parse(day(1)) + 7 * DAY).toISOString(),
    })
    expect(verify(onDay7).filter(issue => issue.part === 'disputes')).toEqual([])
    expect(balance(onDay7)).toBe(balance(ledger))

    const onDay8 = appendDispute(ledger, studentKey, {
      disputeFor: charge.id,
      memo: '合成异议理由',
      at: new Date(Date.parse(day(1)) + 8 * DAY).toISOString(),
    })
    expect(verify(onDay8).some(issue => issue.part === 'disputes' && issue.code === 'dispute-too-late' && issue.index === 0)).toBe(true)
  })

  it('5 退款金额超过“累计充值 − 累计退款”时校验不通过（L2）', () => {
    let over = emptyLedger()
    over = append(over, teacherKey, { type: 'topup', amount: 20, at: day(1) })
    over = append(over, teacherKey, { type: 'refund', amount: 30, at: day(2) })
    expect(verify(over).some(issue => issue.part === 'chain' && issue.code === 'refund-exceeds-topups' && issue.index === 1)).toBe(true)

    let allowed = emptyLedger()
    allowed = append(allowed, teacherKey, { type: 'topup', amount: 20, at: day(1) })
    allowed = append(allowed, teacherKey, { type: 'refund', amount: 20, at: day(2) })
    expect(verify(allowed)).toEqual([])
  })

  it('6 余额持续为负时 overdueSince 返回起始时间，补交回正后返回 null', () => {
    let ledger = emptyLedger()
    ledger = append(ledger, teacherKey, { type: 'topup', amount: 10, at: day(1) })
    ledger = append(ledger, teacherKey, { type: 'charge', amount: 20, chargeReason: 'consult', at: day(3) })
    ledger = append(ledger, teacherKey, { type: 'charge', amount: 5, chargeReason: 'herbs', at: day(4) })
    expect(overdueSince(ledger)).toBe(day(3))

    const recovered = append(ledger, teacherKey, { type: 'topup', amount: 30, at: day(5) })
    expect(overdueSince(recovered)).toBeNull()
  })

  it('7 金额为 0、负数或小数时校验不通过', () => {
    for (const amount of [0, -5, 1.5]) {
      const ledger = append(emptyLedger(), teacherKey, { type: 'charge', amount, chargeReason: 'other', at: day(1) })
      expect(verify(ledger).some(issue => issue.part === 'chain' && issue.code === 'invalid-amount' && issue.index === 0), String(amount)).toBe(true)
    }
  })

  it('8 测试只使用合成公钥和整数金额，账本里不出现真实货币金额', () => {
    expect(teacher).toMatch(/^[0-9a-f]{64}$/)
    expect(student).toMatch(/^[0-9a-f]{64}$/)
    expect(teacher).not.toBe(student)

    let ledger = emptyLedger()
    ledger = append(ledger, teacherKey, { type: 'topup', amount: 100, at: day(1) })
    ledger = append(ledger, teacherKey, { type: 'charge', amount: 50, chargeReason: 'consult', at: day(2) })
    for (const event of ledger.events) {
      const fields = JSON.parse(event.content) as Record<string, unknown>
      expect(Number.isSafeInteger(fields.amount)).toBe(true)
      expect(Number(fields.amount)).toBeGreaterThan(0)
      expect(event.content).not.toMatch(/CNY|USD|金额/)
    }

    // 计价写在老师资料里，不进账本。
    expect(declarePricing({ currency: 'CNY', perCoin: 1 })).toEqual({ currency: 'CNY', perCoin: 1 })
    expect(() => declarePricing({ currency: 'cny', perCoin: 1 })).toThrow()
    expect(() => declarePricing({ currency: 'CNY', perCoin: 0 })).toThrow()
  })

  it('9 记账链只有一个写入者：老师记账与学生提异议互不干扰，异议不进链也不改余额', () => {
    let ledger = emptyLedger()
    ledger = append(ledger, teacherKey, { type: 'topup', amount: 30, at: day(1) })
    ledger = append(ledger, teacherKey, { type: 'charge', amount: 20, chargeReason: 'consult', at: day(2) })
    ledger = appendDispute(ledger, studentKey, { disputeFor: ledger.events[1].id, memo: '合成异议', at: day(3) })
    // 学生提异议之后，老师继续记账，链不会分叉。
    ledger = append(ledger, teacherKey, { type: 'charge', amount: 5, chargeReason: 'herbs', at: day(4) })

    expect(ledger.events).toHaveLength(3)
    expect(ledger.disputes).toHaveLength(1)
    expect(verify(ledger)).toEqual([])
    expect(balance(ledger)).toBe(5)
    expect(odueSinceIsNull(ledger)).toBe(true)
  })

  it('10 异议只能针对链里已存在的扣费', () => {
    let ledger = emptyLedger()
    ledger = append(ledger, teacherKey, { type: 'topup', amount: 10, at: day(1) })
    expect(() => appendDispute(ledger, studentKey, { disputeFor: ledger.events[0].id, memo: '合成异议', at: day(2) })).toThrow()

    const wrongTarget = signDispute(ledger, studentKey, { disputeFor: ledger.events[0].id, memo: '合成异议', at: day(2) })
    expect(verify({ ...ledger, disputes: [wrongTarget] }).some(issue => issue.part === 'disputes' && issue.code === 'unknown-dispute-target')).toBe(true)

    const missing = signDispute(ledger, studentKey, { disputeFor: 'b'.repeat(64), memo: '合成异议', at: day(2) })
    expect(verify({ ...ledger, disputes: [missing] }).some(issue => issue.part === 'disputes' && issue.code === 'unknown-dispute-target')).toBe(true)
  })
})

// 小工具：让第 9 条只关心余额与链，不依赖具体欠费语义。
function odueSinceIsNull(ledger: Ledger): boolean {
  return overdueSince(ledger) === null
}
