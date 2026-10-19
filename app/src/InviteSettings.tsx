import {useState} from 'react'
import {toDataURL} from 'qrcode'
import type {Identity} from './core/identity'
import type {LocalStore} from './core/store'
import {makeInvite,inviteLink,onboardingRequest} from './core/onboarding'
import {loadOwnStorefront} from './core/storefront'
import {storefrontInviteLink} from './core/storefront/invite'
export function InviteSettings({identity,gateway,store}:{identity:Identity;gateway:string;store?:LocalStore}){
 const [link,setLink]=useState(''),[qr,setQr]=useState(''),[token,setToken]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 return <section><button disabled={busy||!gateway} onClick={()=>{setBusy(true);void(async()=>{try{const base=location.href,invite=makeInvite(identity,gateway+'/invite/redeem');let value=inviteLink(base,invite);if(store){const own=await loadOwnStorefront(store,identity);if(own.current)value=storefrontInviteLink(base,invite,own.current)}setQr(await toDataURL(value,{width:320,errorCorrectionLevel:'L'}));setLink(value);setMessage('此邀请7天内有效，可邀请多位学生。')}catch{setMessage('邀请暂时无法生成，请稍后重试。')}finally{setBusy(false)}})()}}>邀请学生</button>
 {link&&<><label>邀请链接<input readOnly value={link} style={{width:'100%'}}/></label><button onClick={()=>void navigator.clipboard?.writeText(link).then(()=>setMessage('邀请已复制，可以发给学生。')).catch(()=>setMessage('请长按邀请链接复制。'))}>复制邀请</button><img src={qr} width={320} height={320} alt="学生扫码即可加入" style={{maxWidth:'100%',height:'auto'}}/></>}
 <details><summary>我是这个社区的老师</summary><p>首次建立社区时，输入部署电脑提供的一次性口令。</p><label>部署口令<input type="password" value={token} onChange={e=>setToken(e.target.value)} autoComplete="off"/></label><button disabled={busy||!token||!gateway} onClick={()=>{setBusy(true);void onboardingRequest(identity,gateway+'/invite/seed',{token}).then(()=>{setToken('');setMessage('社区已建立，可以邀请学生。')}).catch(()=>setMessage('登记未成功，请核对口令，或联系部署者。')).finally(()=>setBusy(false))}}>登记为社区老师</button></details>{message&&<p role="status">{message}</p>}
 </section>
}
