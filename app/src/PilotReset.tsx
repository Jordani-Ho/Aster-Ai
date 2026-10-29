import { useState } from 'react'

// V2-42：内测专用「清空这台设备上的知衡」。
// 只在内测部署构建时打开开关（VITE_PILOT_MODE=1）；正式版本里这个组件直接返回 null。
// 清空分两步：页面先带 ?pilot-clear=1 重新加载，由入口（main.tsx）在本机存储打开前删干净，
// 再回到干净的网址——这样不会被应用自己占着的 IndexedDB 连接挡住删除。
const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
export const PILOT_MODE = env.VITE_PILOT_MODE === '1'
export const PILOT_CLEAR_WORD = '清空'
export const PILOT_CLEAR_PARAM = 'pilot-clear'

export async function clearThisDevice(): Promise<void> {
  try {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister()
  } catch { /* 没有后台脚本就跳过 */ }
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch { /* 存储不可用就跳过 */ }
  try {
    for (const name of await caches.keys()) await caches.delete(name)
  } catch { /* 没有缓存就跳过 */ }
  const names = new Set<string>(['aster-local-store'])
  try {
    for (const item of await indexedDB.databases()) if (item.name) names.add(item.name)
  } catch { /* 浏览器不支持列举就只删知衡自己的库 */ }
  for (const name of names) {
    await new Promise<void>(resolve => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      // 还有别的标签页占着库时会 blocked；这里不等，刷新后由下一次清空补上。
      request.onblocked = () => resolve()
    })
  }
}

export function PilotReset() {
  const [open, setOpen] = useState(false)
  const [word, setWord] = useState('')
  const [error, setError] = useState('')
  if (!PILOT_MODE) return null
  const run = () => {
    if (word.trim() !== PILOT_CLEAR_WORD) { setError('要输入「清空」两个字才会清空。'); return }
    setError('')
    location.replace(location.pathname + '?' + PILOT_CLEAR_PARAM + '=1' + location.hash)
  }
  return <details className="nl-section">
    <summary>内测：清空这台设备</summary>
    {!open
      ? <button type="button" className="nl-link-button" onClick={() => { setOpen(true); setError('') }}>清空这台设备上的知衡</button>
      : <section aria-label="清空这台设备上的知衡">
        <p className="nl-danger-strong">会删掉这台设备上知衡的全部资料（身份、病历、照片、设置），删了找不回。</p>
        <label>输入「{PILOT_CLEAR_WORD}」两个字<input value={word} autoComplete="off" placeholder={PILOT_CLEAR_WORD} onChange={event => { setWord(event.target.value); setError('') }} /></label>
        {error && <p role="alert" className="nl-danger-strong">{error}</p>}
        <button type="button" className="nl-primary" onClick={run}>确认清空</button>
      </section>}
  </details>
}
