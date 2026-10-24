import {finalizeEvent,getEventHash,verifyEvent,type Event} from 'nostr-tools/pure'
import {createIdentity,type Identity} from '../identity'
import {openStore,resumeStore} from '../store'
import type {LocalStore} from '../store'
import {nip98Authorization} from '../llm/nip98'
import {addTeacher} from '../inbox'
import {createLedgerSync} from '../ledger/sync'
export const INVITE_ERROR='邀请暂不可用，请向老师要一个新链接'
// V2-15：第一个邀请 1 小时内有效；有效期是参数，默认仍是 7 天。协议格式不变。
export function makeInvite(identity:Identity,url:string,now=Math.floor(Date.now()/1000),expiresInSeconds=7*86400):Event{
 return JSON.parse(JSON.stringify(finalizeEvent({kind:27235,created_at:now,tags:[['u',url],['method','POST'],['expiration',String(now+expiresInSeconds)],['nonce',crypto.randomUUID()]],content:'{"type":"aster.invite","version":1}'},identity.privateKey)))
}
export function validateInvite(input:Event,url:string,now=Math.floor(Date.now()/1000)):boolean{
 try{const event={id:input.id,pubkey:input.pubkey,sig:input.sig,kind:input.kind,created_at:input.created_at,tags:input.tags.map(t=>[...t]),content:input.content};const one=(name:string)=>{const tags=event.tags.filter(t=>t[0]===name);return tags.length===1&&tags[0].length===2?tags[0][1]:null};const expires=Number(one('expiration'));return event.kind===27235&&event.content==='{"type":"aster.invite","version":1}'&&Number.isSafeInteger(event.created_at)&&event.created_at<=now+60&&Number.isSafeInteger(expires)&&expires>now&&expires>event.created_at&&expires-event.created_at<=604800&&one('u')===url&&one('method')==='POST'&&typeof one('nonce')==='string'&&getEventHash(event)===event.id&&verifyEvent(event)}catch{return false}
}
export function inviteLink(base:string,event:Event):string{const url=new URL(base);url.search='';url.hash='invite='+btoa(JSON.stringify(event)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');return url.href}
export function readInviteLink(link:string):Event|null{const hash=new URL(link).hash.slice(1);if(!hash.startsWith('invite='))return null;try{const encoded=hash.slice(7);if(encoded.length>12000)throw Error();return JSON.parse(atob(encoded.replaceAll('-','+').replaceAll('_','/')))}catch{throw Error(INVITE_ERROR)}}
export function gatewayBase(modelUrl:string):string{return modelUrl.replace(/\/v1\/?$/,'').replace(/\/$/,'')}
// V2-28：从终端/微信复制的一次性口令常带换行或空格（网关会把多出来的字符算进哈希，直接 403）。
// 口令本体是 base64url，不含空白，所以粘贴时去掉所有空格、换行、制表符是安全的。
export function normalizeSetupToken(value:string):string{return value.replace(/\s+/g,'')}
export async function onboardingRequest(identity:Identity,url:string,payload:unknown):Promise<void>{const body=JSON.stringify(payload),authorization=await nip98Authorization(identity.privateKey,url,'POST',body);const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization},body});if(!res.ok)throw Error(res.status===403?INVITE_ERROR:'暂时未能加入社区，请稍后重试。')}
export async function acceptInvite(identity:Identity,store:LocalStore,event:Event,url:string){
 if(!validateInvite(event,url))throw Error(INVITE_ERROR)
 await onboardingRequest(identity,url,{invite:event})
 await addTeacher(store,event.pubkey)
 // V2-10：第一次加入时记下加入时间，观察周期的第一次从这天算起；再打开邀请不覆盖。
 if(!await store.get('settings','joined-at'))await store.put('settings','joined-at',new Date().toISOString() as unknown as import('../store').StoreValue)
 // Before App starts its shared controller; no second live transport and no coin transaction.
 const sync=createLedgerSync({identity,store,send:async()=>''})
 try{await sync.open(event.pubkey,identity.publicKey)}finally{await sync.close()}
 await store.put('settings','role',{role:'student'})
}

let startup:Promise<unknown>=Promise.resolve()
// V2：身份本机自动生成并直接存放，没有助记词、恢复页或刷脸解锁。
export function bootstrapIdentity(){
 const job=startup.then(async()=>{const existing=await resumeStore();if(existing)return existing;const identity=createIdentity(),store=await openStore(identity);return {identity,store}})
 startup=job.then(()=>{},()=>{});return job
}
