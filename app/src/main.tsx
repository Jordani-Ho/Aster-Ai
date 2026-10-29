import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PILOT_CLEAR_PARAM, PILOT_MODE, clearThisDevice } from './PilotReset'
import './base.css'

// V2-42：内测的「清空这台设备」先带 ?pilot-clear=1 重新加载；
// 在这里、应用打开本地存储之前把 IndexedDB / 本地存储 / 后台脚本都清掉，再回到干净网址。
const params = new URLSearchParams(location.search)
const clearing = PILOT_MODE && params.get(PILOT_CLEAR_PARAM) === '1'
if (clearing) {
  document.getElementById('root')!.innerHTML = '<p style="font-family:system-ui,sans-serif;padding:24px">正在清空这台设备上的知衡…</p>'
  void (async () => {
    try { await clearThisDevice() } catch { /* 清不干净也回到干净网址，最多再点一次 */ }
    params.delete(PILOT_CLEAR_PARAM)
    const query = params.toString()
    location.replace(location.pathname + (query ? '?' + query : '') + location.hash)
  })()
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
