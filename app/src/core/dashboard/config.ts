import type { Envelope } from '../transport/crypto'

// V2-14：仪表盘地址与公钥由部署 .env 注入；留空就不发，也不显示入口。
// 仪表盘私钥只保存在运营方自己的浏览器/密码管理器里，不进仓库、不进馆的 .env。
export interface DashboardConfig {
  pubkey: string
  url: string
  configured: boolean
}

const HEX64 = /^[0-9a-f]{64}$/

export function dashboardConfig(env: Record<string, string | undefined>): DashboardConfig {
  const pubkey = typeof env.VITE_DASHBOARD_PUBKEY === 'string' ? env.VITE_DASHBOARD_PUBKEY.trim().toLowerCase() : ''
  const url = typeof env.VITE_DASHBOARD_URL === 'string' ? env.VITE_DASHBOARD_URL.trim() : ''
  const valid = HEX64.test(pubkey) && url !== ''
  return { pubkey: valid ? pubkey : '', url: valid ? url : '', configured: valid }
}

/** 只读仪表盘页面的解密钥匙：支持 #dashboard=<hex> 或 #dashboard-key=<hex>；不放进 URL 查询。 */
export function dashboardKeyFromHash(hash: string): string | null {
  const value = hash.replace(/^#/, '')
  for (const prefix of ['dashboard=', 'dashboard-key=']) {
    if (!value.startsWith(prefix)) continue
    const key = value.slice(prefix.length).trim().toLowerCase()
    return /^[0-9a-f]{64}$/.test(key) ? key : null
  }
  return null
}

export function isStatsEnvelope(envelope: Envelope): boolean {
  return envelope.type === 'community.stats' && envelope.version === 1
}
