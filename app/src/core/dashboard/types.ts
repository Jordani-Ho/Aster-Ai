import pkg from '../../../package.json'
import type { Envelope } from '../transport/crypto'

// V2-14 社区统计：一天一条，只含计数与时长；不含病历、舌象、钱账、公钥、名字、城市、IP。
// 学生本人感受集合（kangbi-self）永远不读、不进这里。
export const STATS_ENVELOPE_TYPE = 'community.stats'
export const STATS_SCHEMA_VERSION = 1
export const APP_VERSION = typeof pkg.version === 'string' ? pkg.version : '0.0.1'

export interface ErrorCounts {
  uncaughtError: number
  unhandledRejection: number
}

export interface DailyStats {
  /** 统计格式版本，便于以后加字段。 */
  version: number
  /** 应用/部署版本号（来自 app/package.json）。 */
  appVersion: string
  /** 本馆本机随机 ID，不是公钥、不是名字；只用来在仪表盘区分不同馆。 */
  hallId: string
  /** 本地日期 YYYY-MM-DD。 */
  date: string
  onlineSeconds: number
  errorCounts: ErrorCounts
  consults: number
  signatures: number
  /** 签字平均用时（分钟，1 位小数）；当天没有签字时留空，不编 0。 */
  avgSignMinutes: number | null
  /** 老师本机收到的学生坚持率趋势里，今天的作业打卡次数之和；没有数据时留空。 */
  homeworkCheckins: number | null
  tongueRecords: number
  students: number
}

export function statsEnvelope(stats: DailyStats): Envelope {
  return { type: STATS_ENVELOPE_TYPE, version: 1, payload: stats }
}
