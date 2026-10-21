import { useEffect, useState } from 'react'
import { toDataURL } from 'qrcode'
import './invite-ticket.css'

// V2-13：第一位学生和后续邀请共用同一个二维码/链接展示块；手机上可直接复制、保存图片或系统分享。
export function InviteTicket({ link, note, alt = '学生扫码即可加入' }: { link: string; note?: string; alt?: string }) {
  const [qr, setQr] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    setQr(''); setMessage('')
    void toDataURL(link, { width: 480, errorCorrectionLevel: 'L' })
      .then(value => { if (active) setQr(value) })
      .catch(() => { if (active) setMessage('二维码生成失败，可以复制链接发给他。') })
    return () => { active = false }
  }, [link])
  const copy = () => void navigator.clipboard?.writeText(link)
    .then(() => setMessage('邀请已复制，可以发给学生。'))
    .catch(() => setMessage('请长按邀请链接复制。'))
  const share = () => {
    if (!navigator.share) return
    void navigator.share({ title: '知衡邀请', text: '扫码或打开链接加入', url: link })
      .then(() => setMessage('已打开分享。'))
      .catch(() => {})
  }
  return <div className="invite-ticket">
    {note && <p className="inbox-note">{note}</p>}
    <label>邀请链接<input readOnly value={link} style={{ width: '100%' }} /></label>
    <div className="invite-ticket-actions">
      <button type="button" onClick={copy}>复制邀请</button>
      {qr && <a className="invite-save" href={qr} download="zhihang-invite.png">保存二维码</a>}
      {typeof navigator !== 'undefined' && 'share' in navigator && <button type="button" onClick={share}>分享邀请</button>}
    </div>
    {qr ? <img src={qr} width={480} height={480} alt={alt} /> : <p className="inbox-note">正在生成二维码…</p>}
    <p className="inbox-note">长按二维码也可以保存或分享。</p>
    {message && <p role="status">{message}</p>}
  </div>
}
