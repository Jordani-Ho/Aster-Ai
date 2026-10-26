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

// V2-37：核心成员登记二维码也把一次性口令放在 fragment，页面读到后马上清除地址栏。
export function takeCoreSeedToken(hash: string = typeof location === 'undefined' ? '' : location.hash): string {
  const match=/#core=([^&\s]+)/.exec(hash)
  if(!match)return ''
  let value=''
  try{value=decodeURIComponent(match[1])}catch{}
  if(typeof location!=='undefined'&&typeof history!=='undefined'&&/#core=/.test(location.hash))history.replaceState(null,'',location.pathname+location.search)
  return normalizeSetupToken(value)
}
