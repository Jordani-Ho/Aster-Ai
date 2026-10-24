import {atomicJson} from './members.js'
import {getEventHash,verifyEvent} from 'nostr-tools/pure'
import {readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {createHash,timingSafeEqual} from 'node:crypto'
export const INVITE_ROUTES=['/invite/redeem','/invite/seed']
// V2-31：首次登记成功后，删掉本机的一次性口令与扫码页（只删这两个固定文件名；
// 目录由部署方在 gateway-config.json 的 setupDir 指定，网关只额外挂载 data/setup，没有对外接口）。
const SETUP_FILES=['teacher-setup-code.txt','teacher-setup.html']
export function cleanupSetupFiles(config){
 try{const dir=config?.setupDir;if(typeof dir!=='string'||dir==='')return;for(const name of SETUP_FILES)rmSync(join(dir,name),{force:true})}catch{/* 删不掉不拦登记；下次 setup 的 verify 会补删 */}
}
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
