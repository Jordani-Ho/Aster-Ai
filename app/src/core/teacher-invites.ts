import { finalizeEvent, getEventHash, verifyEvent, type Event } from 'nostr-tools/pure'
import type { Identity } from './identity'
import { nip98Authorization } from './llm/nip98'

export const TEACHER_INVITE_ERROR='老师推荐链接已失效、已使用或暂不可用，请联系推荐人'
export const CORE_PROMOTION_ERROR='核心成员邀请已失效、已使用或暂不可用，请联系邀请人'
const MAX_AGE=7*24*60*60
const TYPES={teacher:'{"type":"aster.teacher-recommendation","version":1}',promotion:'{"type":"aster.core-promotion","version":1}'}

function tagsOf(event:Event,name:string):string|null{
  const found=event.tags.filter(tag=>tag[0]===name)
  return found.length===1&&found[0].length===2?found[0][1]:null
}
function validSignedTicket(input:Event,url:string,type:keyof typeof TYPES,now=Math.floor(Date.now()/1000)){
  try{
    const event={id:input.id,pubkey:input.pubkey,sig:input.sig,kind:input.kind,created_at:input.created_at,tags:input.tags.map(tag=>[...tag]),content:input.content}
    const allowed=['u','method','expiration','nonce',...(type==='teacher'?['reason']:[])]
    const expires=Number(tagsOf(event,'expiration'))
    return event.kind===27235&&event.content===TYPES[type]&&Number.isSafeInteger(event.created_at)&&event.created_at<=now+60&&Number.isSafeInteger(expires)&&expires>now&&expires>event.created_at&&expires-event.created_at<=MAX_AGE&&tagsOf(event,'u')===url&&tagsOf(event,'method')==='POST'&&typeof tagsOf(event,'nonce')==='string'&&Boolean(tagsOf(event,'nonce'))&&event.tags.every(tag=>tag.length===2&&allowed.includes(tag[0]))&&allowed.every(name=>event.tags.filter(tag=>tag[0]===name).length<=(name==='reason'?1:1))&&getEventHash(event)===event.id&&verifyEvent(event)?event:null
  }catch{return null}
}

export function makeTeacherRecommendation(identity:Identity,url:string,reason:string,now=Math.floor(Date.now()/1000),expiresInSeconds=MAX_AGE):Event{
  const note=reason.trim()
  if(note===''||note.length>240||/[\u0000-\u001f\u007f]/.test(note))throw Error('写一句推荐理由，最多 240 个字。')
  return JSON.parse(JSON.stringify(finalizeEvent({kind:27235,created_at:now,tags:[['u',url],['method','POST'],['expiration',String(now+expiresInSeconds)],['nonce',crypto.randomUUID()],['reason',note]],content:TYPES.teacher},identity.privateKey))) as Event
}
export function makeCorePromotion(identity:Identity,url:string,now=Math.floor(Date.now()/1000),expiresInSeconds=MAX_AGE):Event{
  return JSON.parse(JSON.stringify(finalizeEvent({kind:27235,created_at:now,tags:[['u',url],['method','POST'],['expiration',String(now+expiresInSeconds)],['nonce',crypto.randomUUID()]],content:TYPES.promotion},identity.privateKey))) as Event
}
export function validateTeacherRecommendation(event:Event,url:string,now=Math.floor(Date.now()/1000)){
  const valid=validSignedTicket(event,url,'teacher',now)
  const reason=valid&&tagsOf(valid,'reason')
  return Boolean(valid&&typeof reason==='string'&&reason.trim()!==''&&reason.length<=240&&!/[\u0000-\u001f\u007f]/.test(reason))
}
export function validateCorePromotion(event:Event,url:string,now=Math.floor(Date.now()/1000)){
  return Boolean(validSignedTicket(event,url,'promotion',now))
}

function encodeEvent(event:Event){
  const bytes=new TextEncoder().encode(JSON.stringify(event));let binary=''
  for(const byte of bytes)binary+=String.fromCharCode(byte)
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')
}
function readEvent(link:string,key:string):Event|null{
  const hash=new URL(link).hash.slice(1)
  if(!hash.startsWith(key+'='))return null
  try{
    const encoded=hash.slice(key.length+1)
    if(encoded.length>12000)throw Error()
    const binary=atob(encoded.replaceAll('-','+').replaceAll('_','/'))
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary,char=>char.charCodeAt(0)))) as Event
  }catch{throw Error(key==='teacher-invite'?TEACHER_INVITE_ERROR:CORE_PROMOTION_ERROR)}
}
export function teacherRecommendationLink(base:string,event:Event){const url=new URL(base);url.search='';url.hash='teacher-invite='+encodeEvent(event);return url.href}
export function corePromotionLink(base:string,event:Event){const url=new URL(base);url.search='';url.hash='core-add='+encodeEvent(event);return url.href}
export function readTeacherRecommendationLink(link:string){return readEvent(link,'teacher-invite')}
export function readCorePromotionLink(link:string){return readEvent(link,'core-add')}

async function signedRequest(identity:Identity,url:string,payload:unknown){
  const body=JSON.stringify(payload),authorization=await nip98Authorization(identity.privateKey,url,'POST',body)
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization},body})
  let value:unknown={}
  try{value=await response.json()}catch{}
  if(!response.ok){const message=(value as {error?:unknown})?.error;throw Error(typeof message==='string'?message:response.status===403?TEACHER_INVITE_ERROR:'暂时无法连接社区，请稍后重试。')}
  return value
}
export async function registerRecommendedTeacher(identity:Identity,gateway:string,event:Event){
  await signedRequest(identity,gateway.replace(/\/$/,'')+'/invite/teacher',{recommendation:event})
}
export async function claimCorePromotion(identity:Identity,gateway:string,event:Event){
  await signedRequest(identity,gateway.replace(/\/$/,'')+'/invite/core-add',{promotion:event})
}
export async function coreMemberStatus(identity:Identity,gateway:string){
  const value=await signedRequest(identity,gateway.replace(/\/$/,'')+'/invite/core-status',{}) as {teacher?:unknown;core?:unknown}
  return {teacher:value.teacher===true,core:value.core===true}
}
