import { useEffect, useState } from 'react'
import type { Event } from 'nostr-tools/pure'
import type { Identity } from './core/identity'
import { coreMemberStatus, corePromotionLink, makeCorePromotion, makeTeacherRecommendation, teacherRecommendationLink } from './core/teacher-invites'
import { InviteTicket } from './InviteTicket'

export function CoreMemberActions({identity,gateway,notice=''}:{identity:Identity;gateway:string;notice?:string}){
  const [core,setCore]=useState(false)
  const [reason,setReason]=useState('')
  const [link,setLink]=useState('')
  const [kind,setKind]=useState<'teacher'|'promotion'|null>(null)
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  useEffect(()=>{
    let active=true
    if(!gateway)return
    void coreMemberStatus(identity,gateway).then(value=>{if(active)setCore(value.core)}).catch(()=>{if(active)setCore(false)})
    return()=>{active=false}
  },[identity,gateway])
  if(!core)return null
  const generate=(type:'teacher'|'promotion')=>{
    setBusy(true);setMessage('');setLink('');setKind(null)
    try{
      const base=location.href
      const event:Event=type==='teacher'
        ?makeTeacherRecommendation(identity,gateway+'/invite/teacher',reason)
        :makeCorePromotion(identity,gateway+'/invite/core-add')
      setLink(type==='teacher'?teacherRecommendationLink(base,event):corePromotionLink(base,event))
      setKind(type);setMessage(type==='teacher'?'链接 7 天内有效，只能登记一位新老师。':'链接 7 天内有效，只能由一位已登记老师使用。')
    }catch(cause){setMessage(cause instanceof Error?cause.message:'邀请暂时无法生成。')}
    finally{setBusy(false)}
  }
  return <section aria-label="老师邀请">
    <h3>老师邀请</h3>
    {notice&&<p role="status">{notice}</p>}
    <p className="nl-quiet">您是核心成员，可以推荐新老师，也可以邀请已登记老师成为核心成员。</p>
    <label>为什么推荐这位老师<textarea rows={3} maxLength={240} value={reason} onChange={event=>setReason(event.target.value)} placeholder="写一句推荐理由" /></label>
    <button type="button" disabled={busy||reason.trim()===''} onClick={()=>generate('teacher')}>推荐一位老师</button>
    <button type="button" disabled={busy} onClick={()=>generate('promotion')}>邀请已登记老师成为核心成员</button>
    {message&&<p role="status">{message}</p>}
    {link&&kind==='teacher'&&<InviteTicket link={link} note="请把链接发给被推荐的老师。登记成功后，这张链接就不能再用了。" alt="新老师扫码登记" />}
    {link&&kind==='promotion'&&<InviteTicket link={link} note="请让已登记的老师用自己的手机打开。链接只能使用一次。" alt="老师扫码成为核心成员" />}
  </section>
}
