import { useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import { makeInvite, inviteLink } from './core/onboarding'
import { loadOwnStorefront } from './core/storefront'
import { storefrontInviteLink } from './core/storefront/invite'
import { InviteTicket } from './InviteTicket'

// V2-15 管理页“邀请学生”：开馆后的第 2 位及以后，沿用现有 7 天有效期。
// 登记社区老师已移到建馆引导第 2 步，这里不再重复出现。
export function InviteSettings({ identity, gateway, store, validitySeconds = 7 * 86400 }: {
  identity: Identity
  gateway: string
  store?: LocalStore
  validitySeconds?: number
}) {
  const [link, setLink] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const days = validitySeconds === 7 * 86400 ? '7 天' : validitySeconds === 3600 ? '1 小时' : `${Math.round(validitySeconds / 3600)} 小时`
  return <section aria-label="邀请学生（第二位及以后）">
    <button disabled={busy || !gateway} onClick={() => {
      setBusy(true); setMessage('')
      void (async () => {
        try {
          const base = location.href
          const invite = makeInvite(identity, gateway + '/invite/redeem', undefined, validitySeconds)
          let value = inviteLink(base, invite)
          if (store) {
            const own = await loadOwnStorefront(store, identity)
            if (own.current) value = storefrontInviteLink(base, invite, own.current)
          }
          setLink(value)
          setMessage(`此邀请${days}内有效，可邀请多位学生。`)
        } catch { setMessage('邀请暂时无法生成，请稍后重试。') } finally { setBusy(false) }
      })()
    }}>生成邀请</button>
    {link && <InviteTicket link={link} />}
    {message && <p role="status">{message}</p>}
  </section>
}
