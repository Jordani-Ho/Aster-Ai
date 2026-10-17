import { getEventHash, getPublicKey, generateSecretKey, finalizeEvent, verifyEvent, type Event, type EventTemplate } from 'nostr-tools/pure'
import { createRumor, createSeal, unwrapEvent } from 'nostr-tools/nip59'
import { v2 } from 'nostr-tools/nip44'
export const TTL_SECONDS = 30*24*60*60
export const MAX_EVENT_BYTES = 2*1024*1024
export interface Envelope { type:string; version:1; payload:unknown }
export interface Message { id:string; sender:string; at:number; envelope:Envelope }
export function validSignature(event:Event):boolean {
 try { const clean:Event=JSON.parse(JSON.stringify({id:event.id,pubkey:event.pubkey,kind:event.kind,created_at:event.created_at,tags:event.tags,content:event.content,sig:event.sig})); return getEventHash(clean)===clean.id && verifyEvent(clean) } catch { return false }
}
export function expiration(event:Event):number {
 const tags=event.tags.filter(tag=>tag[0]==='expiration')
 if(tags.length!==1 || !/^\d+$/.test(tags[0][1])) throw Error('过期时间无效')
 const value=Number(tags[0][1]);if(!Number.isSafeInteger(value))throw Error('过期时间无效');return value
}
export function assertEnvelope(value:unknown):asserts value is Envelope {
 const e=value as Envelope
 if(!e || typeof e!=='object' || Array.isArray(e) || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(e.type) || e.version!==1 || !Object.hasOwn(e,'payload'))throw Error('应用信封无效')
 const check=(input:unknown):void=>{if(input===null || typeof input==='string'||typeof input==='boolean'||(typeof input==='number'&&Number.isFinite(input)))return;if(Array.isArray(input)){input.forEach(check);return}if(input&&typeof input==='object'&&Object.getPrototypeOf(input)===Object.prototype){Object.values(input).forEach(check);return}throw Error('信封载荷必须为JSON')}
 check(e.payload)
}
export function wrapMessage(key:Uint8Array,recipient:string,envelope:Envelope,now=Math.floor(Date.now()/1000)):{id:string;events:Event[]} {
 if(!/^[0-9a-f]{64}$/.test(recipient))throw Error('收件公钥无效')
 assertEnvelope(envelope)
 const rumor=createRumor({kind:14,created_at:now,tags:[['p',recipient],['nonce',crypto.randomUUID()]],content:JSON.stringify(envelope)},key)
 const events=[...new Set([recipient,getPublicKey(key)])].map(receiver=>{
  const seal=createSeal(rumor,key,receiver), ephemeral=generateSecretKey()
  const createdAt=now-1-(crypto.getRandomValues(new Uint32Array(1))[0]%172799)
  try { const event=finalizeEvent({kind:1059,created_at:createdAt,tags:[['p',receiver],['expiration',String(createdAt+TTL_SECONDS)]],content:v2.encrypt(JSON.stringify(seal),v2.utils.getConversationKey(ephemeral,receiver))},ephemeral)
   if(new TextEncoder().encode(JSON.stringify(event)).length>MAX_EVENT_BYTES)throw Error('加密包裹超过2MB')
   return event
  } finally {ephemeral.fill(0)}
 })
 return {id:rumor.id,events}
}
export function openMessage(event:Event,key:Uint8Array,now=Math.floor(Date.now()/1000)):Message {
 if(new TextEncoder().encode(JSON.stringify(event)).length>MAX_EVENT_BYTES || event.kind!==1059 || !validSignature(event))throw Error('包裹签名无效')
 const owner=getPublicKey(key)
 if(event.tags.filter(tag=>tag[0]==='p').length!==1 || !event.tags.some(tag=>tag[0]==='p'&&tag[1]===owner))throw Error('包裹不属于本人')
 if(expiration(event)<=now)throw Error('包裹已过期')
 const rumor=unwrapEvent(JSON.parse(JSON.stringify(event)),key)
 if(rumor.kind!==14 || Object.hasOwn(rumor,'sig') || getEventHash(rumor)!==rumor.id || !Number.isSafeInteger(rumor.created_at))throw Error('内部消息无效')
 if(rumor.pubkey!==owner && !rumor.tags.some(tag=>tag[0]==='p'&&tag[1]===owner))throw Error('内部收件人不一致')
 const envelope:unknown=JSON.parse(rumor.content);assertEnvelope(envelope)
 return {id:rumor.id,sender:rumor.pubkey,at:rumor.created_at,envelope}
}
export function authTemplate(url:string,challenge:string):EventTemplate {return {kind:22242,created_at:Math.floor(Date.now()/1000),tags:[['relay',url],['challenge',challenge]],content:''}}
