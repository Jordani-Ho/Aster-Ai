import {atomicJson} from './members.js'
import {getEventHash,verifyEvent} from 'nostr-tools/pure'
import {readFileSync} from 'node:fs'
import {createHash,timingSafeEqual} from 'node:crypto'
export const INVITE_ROUTES=['/invite/redeem','/invite/seed']
export function validInvite(input,url,members,now=Math.floor(Date.now()/1000)){
 try{
  const event={id:input.id,pubkey:input.pubkey,sig:input.sig,kind:input.kind,created_at:input.created_at,tags:input.tags.map(t=>[...t]),content:input.content}
  const one=name=>{const tags=event.tags.filter(t=>t[0]===name);return tags.length===1&&tags[0].length===2?tags[0][1]:null}
  const expires=Number(one('expiration'))
  return event.kind===27235&&event.content==='{"type":"aster.invite","version":1}'&&members.has(event.pubkey)&&Number.isSafeInteger(event.created_at)&&event.created_at<=now+60&&Number.isSafeInteger(expires)&&expires>now&&expires>event.created_at&&expires-event.created_at<=604800&&one('u')===url&&one('method')==='POST'&&typeof one('nonce')==='string'&&getEventHash(event)===event.id&&verifyEvent(event)
 }catch{return false}
}
export function seedAllowed(config,_members,token,caller){
 try{if(!config.seedTokenFile||typeof token!=='string'||token.length>256)return false;const record=JSON.parse(readFileSync(config.seedTokenFile,'utf8'));if(record.usedFor&&record.usedFor!==caller)return false;const expected=record.tokenHash;if(!/^[0-9a-f]{64}$/.test(expected))return false;if(!timingSafeEqual(Buffer.from(expected,'hex'),createHash('sha256').update(token).digest()))return false;if(!record.usedFor)atomicJson(config.seedTokenFile,{tokenHash:expected,usedFor:caller});return true}catch{return false}
}
