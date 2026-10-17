import { useState } from 'react'
import type { Identity } from './core/identity'
import { createPushClient, needsInstallHint, pushEnvironment } from './core/push'
export function PushSettings({ identity }: { identity: Identity }) {
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const environment = pushEnvironment()
  const execute = async (action: 'subscribe' | 'unsubscribe') => {
    setBusy(true)
    try {
      await createPushClient({ gatewayUrl: url, vapidPublicKey: key, secretKey: identity.privateKey })[action]()
      setStatus(action === 'subscribe' ? '已开启新消息提醒' : '已关闭新消息提醒')
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  return <section aria-label="新消息提醒">
    <h2>新消息提醒</h2>
    {needsInstallHint(environment) && <p>添加到主屏幕可以收到提醒。当前环境不支持时，请打开应用查看新消息。</p>}
    <p>通知只显示“知衡：有新消息”。</p>
    <label>提醒服务地址<input type="url" value={url} onChange={e=>setUrl(e.target.value)} style={{width:'100%',boxSizing:'border-box'}} /></label>
    <label>服务方提供的推送公钥<input value={key} onChange={e=>setKey(e.target.value)} style={{width:'100%',boxSizing:'border-box'}} /></label>
    <p><button disabled={busy || !url || !key || needsInstallHint(environment)} onClick={()=>void execute('subscribe')}>开启提醒</button>{' '}
    <button disabled={busy || !url} onClick={()=>void execute('unsubscribe')}>关闭提醒</button></p>
    <p role="status">{status}</p>
  </section>
}
