import type { LocalStore, StoreValue } from '../store'
import { localDay } from '../homework/schedule'

// V2-14：服务在线时长的口径 = 本机应用当天累计开着的秒数。
// 打开应用时发当天统计，所以这个数只含本次打开前已累计的时长 + 本次已开的几秒；
// 换天重新累计；数据不足（没有记录）时按 0 秒，不编造。
export const SESSION_SETTING = 'dashboard-session'

interface DaySession {
  date: string
  seconds: number
  startedAt: number
}

function session(value: unknown): DaySession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.date !== 'string' || !Number.isFinite(v.seconds) || !Number.isFinite(v.startedAt)) return null
  return { date: v.date, seconds: Math.max(0, Math.floor(v.seconds as number)), startedAt: v.startedAt as number }
}

async function read(store: Pick<LocalStore, 'get'>): Promise<DaySession | null> {
  return session(await store.get('settings', SESSION_SETTING))
}

async function write(store: Pick<LocalStore, 'put'>, value: DaySession): Promise<void> {
  await store.put('settings', SESSION_SETTING, value as unknown as StoreValue)
}

/** 应用打开时调用；返回 tick/stop，把本次会话累计进当天。 */
export async function startStatsSession(store: Pick<LocalStore, 'get' | 'put'>, now = Date.now()): Promise<{ tick: () => Promise<void>; stop: () => Promise<void> }> {
  const today = localDay(new Date(now))
  const prior = await read(store)
  const state: DaySession = prior?.date === today ? { ...prior, startedAt: now } : { date: today, seconds: 0, startedAt: now }
  await write(store, state)
  const tick = async () => {
    const current = await read(store)
    if (!current) return
    const at = Date.now()
    if (current.date !== localDay(new Date(at))) {
      await write(store, { date: localDay(new Date(at)), seconds: 0, startedAt: at })
      return
    }
    const elapsed = Math.max(0, Math.floor((at - current.startedAt) / 1000))
    await write(store, { date: current.date, seconds: current.seconds + elapsed, startedAt: at })
  }
  return { tick, stop: tick }
}

export async function currentOnlineSeconds(store: Pick<LocalStore, 'get'>, now = Date.now()): Promise<number> {
  const today = localDay(new Date(now))
  const state = await read(store)
  if (!state || state.date !== today) return 0
  return state.seconds + Math.max(0, Math.floor((now - state.startedAt) / 1000))
}
