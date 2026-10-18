import { jieqiDate } from './calendar'
import data from './seasonal.json'

// 通用节气养生：24 节气各一段起居、饮食、情志要点，只写传统养生常识，不写具体药方。
// 数据本体在 seasonal.json；本文件只提供类型与查询，不做健康判断。
export interface SeasonalTexts {
  living: string
  diet: string
  emotion: string
}

const table = data as Record<string, SeasonalTexts>

// 公历一年里节气的先后顺序（小寒在一月初，冬至在十二月末）。
export const JIEQI_CHRONO: readonly string[] = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
  '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
]

export const SEASONAL_JIEQI: readonly string[] = Object.keys(table)

function localDay(at: Date): string {
  return [at.getFullYear(), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0')].join('-')
}

export function seasonalTexts(jieqi: string): SeasonalTexts | null {
  const row = table[jieqi]
  if (!row) return null
  return { living: row.living, diet: row.diet, emotion: row.emotion }
}

// 返回某天所处的节气名（取最近一个已到的节气；1 月初小寒之前属上年冬至）。
export function currentJieqi(at: Date): string {
  if (!Number.isFinite(at.getTime())) throw new Error('日期无效')
  const day = localDay(at)
  let current = '冬至'
  for (const name of JIEQI_CHRONO) {
    if (jieqiDate(at.getFullYear(), name) <= day) current = name
    else break
  }
  return current
}
