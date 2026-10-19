import type { LocalStore, StoreValue } from '../store'

// V2-08 第 6 条：舌象抽象的级别由老师定。默认第一级（只留舌头裁剪图 + 候选特征，老师说了算）；
// 本版只实现第一级，第三级（只留特征值、不留裁剪图）先不开放；第二级的“改值记进思想指纹”已随本卡生效。
export const TONGUE_LEVEL_SETTING = 'tongue-level'
export const TONGUE_LEVEL_DEFAULT = 1
export const TONGUE_LEVELS = [1] as const
export type TongueLevel = typeof TONGUE_LEVELS[number]

export function validTongueLevel(value: unknown): value is TongueLevel {
  return value === 1
}

export async function loadTongueLevel(store: Pick<LocalStore, 'get'>): Promise<TongueLevel> {
  const value = await store.get('settings', TONGUE_LEVEL_SETTING)
  return validTongueLevel(value) ? value : TONGUE_LEVEL_DEFAULT
}

export async function saveTongueLevel(store: Pick<LocalStore, 'put'>, level: number): Promise<void> {
  if (!validTongueLevel(level)) throw new Error('本版只开放第一级')
  await store.put('settings', TONGUE_LEVEL_SETTING, level as unknown as StoreValue)
}

export function tongueLevelLabel(level: TongueLevel): string {
  return level === 1 ? '第一级 · 只留舌头裁剪图与候选特征（老师定值）' : '未开放的级别'
}
