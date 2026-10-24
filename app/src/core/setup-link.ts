import { normalizeSetupToken } from './onboarding'

// V2-31：扫码登记链接把一次性口令放在 #setup= 后面（浏览器不会把 # 后的内容发给服务器，
// 隧道与网关日志里都不会出现）。读到口令就立刻从地址栏清掉，避免刷新/截图/复制地址时带出口令。
export function takeSetupToken(hash: string = typeof location === 'undefined' ? '' : location.hash): string {
  const match = /#setup=([^&\s]+)/.exec(hash)
  if (!match) return ''
  let value = ''
  try { value = decodeURIComponent(match[1]) } catch { value = '' }
  if (typeof location !== 'undefined' && typeof history !== 'undefined' && /#setup=/.test(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search)
  }
  return normalizeSetupToken(value)
}
