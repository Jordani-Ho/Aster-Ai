import { getContact } from './core/redflags'
import type { RedFlagResult } from './core/redflags'

interface RedFlagAlertProps {
  result: RedFlagResult
  region: string | null
  status: string
  onNotifyTeacher: () => void
  onDismiss: () => void
}

// 全屏急症提示。只说“请就医”，不给诊断或分诊结论。
export function RedFlagAlert({ result, region, status, onNotifyTeacher, onDismiss }: RedFlagAlertProps) {
  const crisis = result.category?.action === 'crisis'
  const contact = getContact(region, crisis ? 'crisis' : 'emergency')
  const fallback = crisis ? '请拨打当地心理援助热线，或让可信任的人陪着你' : '请拨打当地急救电话'
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="急症提示"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#fff', color: '#111', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 16, padding: 24, overflowY: 'auto' }}
    >
      <p style={{ margin: 0, fontWeight: 700, letterSpacing: 2 }}>急症提示</p>
      <h1 style={{ margin: 0, fontSize: 32, lineHeight: 1.2 }}>请立即就医</h1>
      {crisis && <p style={{ margin: 0 }}>你并不孤单。如果现在就处于危险中，请立即联系专业援助。</p>}
      <p style={{ margin: 0, fontSize: 28 }}>
        {contact
          ? <><strong>{contact.number}</strong>{contact.name ? ' · ' + contact.name : ''}</>
          : fallback}
      </p>
      <p style={{ margin: 0, color: '#555' }}>这是本地筛查，不是诊断；如有紧急情况，请立即前往医院或拨打急救电话。</p>
      {result.matched.length > 0 && <p style={{ margin: 0, color: '#555' }}>检测到：{result.matched.join('、')}</p>}
      {result.source === 'model' && <p style={{ margin: 0, color: '#555' }}>由模型复核补充</p>}
      {status && <p role="status">{status}</p>}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button type="button" onClick={onNotifyTeacher}>通知老师</button>
        <button type="button" onClick={onDismiss}>我已知晓</button>
      </div>
    </div>
  )
}
