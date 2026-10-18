import { parseChainFields, type Ledger, type SignedLedgerEvent } from './types'

// M1-22 一家一本账：账本页按家人筛选扣费。`null` 表示全部扣费；
// SELF_MEMBER 表示没有 forMember 的本人扣费；其他值按家人称呼精确匹配。
export const SELF_MEMBER = ''

function chargeMember(event: SignedLedgerEvent): string | null {
  try {
    const fields = parseChainFields(event)
    return fields.type === 'charge' ? fields.forMember ?? null : null
  } catch { return null }
}

export function filterChargesByMember(ledger: Ledger, member: string | null): SignedLedgerEvent[] {
  const charges = ledger.events.filter(event => {
    try { return parseChainFields(event).type === 'charge' } catch { return false }
  })
  if (member === null) return charges
  return charges.filter(event => (chargeMember(event) ?? SELF_MEMBER) === member)
}
