import { meridians } from '../../../../domain/tcm/calendar'

/** 每条新记录带的天地人：时辰、节气、城市（城市未知为 null）。 */
export interface HeavenStamp {
  shichen: string
  jieqi: string
  city: string | null
}

/** 十二时辰（子…亥），与领域表一致。 */
export const SHICHEN: readonly string[] = meridians.map(item => item.name)

/** 严格校验记录里的 heaven：只有三个字段，时辰必须是十二时辰之一，城市可为 null。 */
export function isHeavenStamp(value: unknown): value is HeavenStamp {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const stamp = value as Record<string, unknown>
  if (Object.keys(stamp).sort().join(',') !== 'city,jieqi,shichen') return false
  if (typeof stamp.shichen !== 'string' || !SHICHEN.includes(stamp.shichen)) return false
  if (typeof stamp.jieqi !== 'string' || stamp.jieqi.trim() === '' || stamp.jieqi.length > 20) return false
  return stamp.city === null || (typeof stamp.city === 'string' && stamp.city.length <= 80)
}
