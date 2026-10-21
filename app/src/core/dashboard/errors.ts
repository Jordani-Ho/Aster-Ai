import type { LocalStore, StoreValue } from '../store'
import { localDay } from '../homework/schedule'
import type { ErrorCounts } from './types'

// V2-14：只记错误类型与次数，不记内容、不记堆栈。
export const ERROR_SETTING = 'dashboard-errors'
export type DashboardErrorType = keyof ErrorCounts
export const DASHBOARD_ERROR_TYPES: readonly DashboardErrorType[] = ['uncaughtError', 'unhandledRejection']

export function emptyErrorCounts(): ErrorCounts {
  return { uncaughtError: 0, unhandledRejection: 0 }
}

function counts(value: unknown): ErrorCounts {
  const result = emptyErrorCounts()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const countsValue = (value as { counts?: unknown }).counts
  if (!countsValue || typeof countsValue !== 'object' || Array.isArray(countsValue)) return result
  for (const type of DASHBOARD_ERROR_TYPES) {
    const number = (countsValue as Record<string, unknown>)[type]
    if (Number.isSafeInteger(number) && (number as number) >= 0) result[type] = number as number
  }
  return result
}

export async function recordError(store: Pick<LocalStore, 'get' | 'put'>, type: DashboardErrorType, now = new Date()): Promise<void> {
  if (!DASHBOARD_ERROR_TYPES.includes(type)) return
  const date = localDay(now)
  const stored = await store.get('settings', ERROR_SETTING) as { date?: unknown; counts?: unknown } | undefined
  const current = stored && stored.date === date ? counts(stored) : emptyErrorCounts()
  current[type] += 1
  await store.put('settings', ERROR_SETTING, { date, counts: current } as unknown as StoreValue)
}

export async function loadErrorCounts(store: Pick<LocalStore, 'get'>, now = new Date()): Promise<ErrorCounts> {
  const stored = await store.get('settings', ERROR_SETTING) as { date?: unknown; counts?: unknown } | undefined
  return stored && stored.date === localDay(now) ? counts(stored) : emptyErrorCounts()
}
