import { Solar } from 'lunar-typescript'
import data from './meridians.json'
export const meridians = data
export function shichenAt(at: Date) {
  if (!Number.isFinite(at.getTime())) throw new Error('日期无效')
  return meridians[Math.floor(((at.getHours() + 1) % 24) / 2)]
}
export function shichenStart(name: string): number {
  const row = meridians.find(item => item.name === name)
  if (!row) throw new Error('时辰无效')
  return row.startHour
}
const tables = new Map<number, Record<string,string>>()
export function jieqiDate(year: number, name: string): string {
  if (!Number.isInteger(year) || year < 1901 || year > 2099) throw new Error('节气年份须为1901至2099')
  let table = tables.get(year)
  if (!table) {
    const values = Solar.fromYmd(year, 6, 1).getLunar().getJieQiTable()
    table = Object.fromEntries(Object.entries(values).map(([key, value])=>[key,value.toYmd()]))
    // 库的中文冬至指上年；本年的冬至使用DONG_ZHI。
    table['冬至'] = values.DONG_ZHI.toYmd()
    tables.set(year,table)
  }
  const result = table[name]
  if (!result || !/[\u4e00-\u9fff]/.test(name)) throw new Error('节气名称无效')
  return result
}
