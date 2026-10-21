import { useEffect, useState } from 'react'
import { toDataURL } from 'qrcode'

// V2-15：第一位学生和后续邀请共用同一个二维码/链接展示块；链接由调用方按有效期生成。
export function InviteTicket({ link, note, alt = '学生扫码即可加入' }: { link: string; note?: string; alt?: string }) {
  const [qr, setQr] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    setQr(''); setMessage('')
    void toDataURL(link, { width: 320, errorCorrectionLevel: 'L' })
      .then(value => { if (active) setQr(value) })
      .catch(() => { if (active) setMessage('二维码生成失败，可以复制链接发给他。') })
    return () => { active = false }
  }, [link])
  const copy = () => void navigator.clipboard?.writeText(link)
    .then(() => setMessage('邀请已复制，可以发给学生。'))
    .catch(() => setMessage('请长按邀请链接复制。'))
  return <div className="invite-ticket">
    {note && <p className="inbox-note">{note}</p>}
    <label>邀请链接<input readOnly value={link} style={{ width: '100%' }} /></label>
    <button type="button" onClick={copy}>复制邀请</button>
    {qr ? <img src={qr} width={320} height={320} alt={alt} style={{ maxWidth: '100%', height: 'auto' }} /> : <p className="inbox-note">正在生成二维码…</p>}
    {message && <p role="status">{message}</p>}
  </div>
}
