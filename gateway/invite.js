import {atomicJson} from './members.js'
import {getEventHash,verifyEvent} from 'nostr-tools/pure'
import {readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {createHash,timingSafeEqual} from 'node:crypto'

export const INVITE_ROUTES=['/invite/redeem','/invite/seed','/invite/core-seed','/invite/teacher','/invite/core-add','/invite/core-status']
export const ONBOARDING_ROUTES=['/invite/redeem','/invite/seed','/invite/core-seed','/invite/teacher','/invite/core-add']
const TEACHER_SETUP_FILES=['teacher-setup-code.txt','teacher-setup.html']
const CORE_SETUP_FILES=['core-member-code.txt','core-member.html']
const MAX_LIFETIME=604800
const EVENT_TYPES={student:'{"type":"aster.invite","version":1}',teacher:'{"type":"aster.teacher-recommendation","version":1}',promotion:'{"type":"aster.core-promotion","version":1}'}

function cleanupFiles(config,names){
 try{const dir=config?.setupDir;if(typeof dir!=='string'||dir==='')return;for(const name of names)rmSync(join(dir,name),{force:true})}catch{/* 本机 setup 的 verify 会补删 */}
}
export function cleanupSetupFiles(config){cleanupFiles(config,TEACHER_SETUP_FILES)}
export function cleanupCoreSetupFiles(config){cleanupFiles(config,CORE_SETUP_FILES)}

function copyEvent(input){return {id:input.id,pubkey:input.pubkey,sig:input.sig,kind:input.kind,created_at:input.created_at,tags:input.tags.map(t=>[...t]),content:input.content}}
function one(event,name){const tags=event.tags.filter(t=>t[0]===name);return tags.length===1&&tags[0].length===2?tags[0][1]:null}
function signedEvent(input,url,type,now,requiredTags){
 try{
  const event=copyEvent(input),expires=Number(one(event,'expiration'))
  const allowed=new Set(['u','method','expiration','nonce',...requiredTags])
  return event.kind===27235&&event.content===EVENT_TYPES[type]&&Number.isSafeInteger(event.created_at)&&event.created_at<=now+60&&Number.isSafeInteger(expires)&&expires>now&&expires>event.created_at&&expires-event.created_at<=MAX_LIFETIME&&one(event,'u')===url&&one(event,'method')==='POST'&&typeof one(event,'nonce')==='string'&&one(event,'nonce').length>0&&event.tags.every(tag=>tag.length===2&&allowed.has(tag[0]))&&[...allowed].every(name=>event.tags.filter(tag=>tag[0]===name).length<=1)&&getEventHash(event)===event.id&&verifyEvent(event)?event:null
 }catch{return null}
}

export function validInvite(input,url,members,now=Math.floor(Date.now()/1000)){
 const event=signedEvent(input,url,'student',now,[])
 return Boolean(event&&members.isTeacher(event.pubkey))
}
export function validTeacherRecommendation(input,url,members,now=Math.floor(Date.now()/1000)){
 const event=signedEvent(input,url,'teacher',now,['reason'])
 const reason=event&&one(event,'reason')
 return Boolean(event&&members.isCoreMember(event.pubkey)&&typeof reason==='string'&&reason.trim()!==''&&reason.length<=240&&!/[\u0000-\u001f\u007f]/.test(reason))
}
export function validPromotion(input,url,members,now=Math.floor(Date.now()/1000)){
 const event=signedEvent(input,url,'promotion',now,[])
 return Boolean(event&&members.isCoreMember(event.pubkey))
}

function tokenAllowed(file,token,caller){
 try{if(!file||typeof token!=='string'||token.length>256)return false;const record=JSON.parse(readFileSync(file,'utf8'));if(record.usedFor&&record.usedFor!==caller)return false;const expected=record.tokenHash;if(!/^[0-9a-f]{64}$/.test(expected))return false;if(!timingSafeEqual(Buffer.from(expected,'hex'),createHash('sha256').update(token).digest()))return false;if(!record.usedFor)atomicJson(file,{tokenHash:expected,usedFor:caller});return true}catch{return false}
}
export function seedAllowed(config,members,token,caller){if(members.hasCoreMembers())return false;return tokenAllowed(config.seedTokenFile,token,caller)}
export function coreSeedAllowed(config,members,token,caller){
 if(members.hasCoreMembers())return false
 return tokenAllowed(config.coreSeedTokenFile,token,caller)
}

function readClaims(file){try{const value=JSON.parse(readFileSync(file,'utf8'));if(!Array.isArray(value)||value.some(row=>!row||typeof row.eventId!=='string'||typeof row.teacher!=='string'))throw Error('invalid recommendation records');return value}catch(error){if(error?.code==='ENOENT')return [];throw error}}
function claimEvent(file,event,caller,record){
 try{
  if(typeof file!=='string'||file==='')return false
  const claims=readClaims(file),existing=claims.find(row=>row?.eventId===event.id)
  if(existing)return existing.teacher===caller&&existing.status==='pending'
  atomicJson(file,[...claims,{...record,eventId:event.id,teacher:caller,status:'pending'}])
  return true
 }catch{return false}
}
function completeClaim(file,eventId,caller){
 const claims=readClaims(file),index=claims.findIndex(row=>row.eventId===eventId)
 if(index<0||claims[index].teacher!==caller||claims[index].status!=='pending')throw Error('recommendation claim unavailable')
 claims[index]={...claims[index],status:'used'}
 atomicJson(file,claims)
}
export function redeemTeacherRecommendation(config,input,url,members,caller,now=Math.floor(Date.now()/1000)){
 if(!validTeacherRecommendation(input,url,members,now))return false
 const event=copyEvent(input),reason=one(event,'reason')
 if(!claimEvent(config.recommendationsFile,event,caller,{kind:'recommendation',recommender:event.pubkey,createdAt:event.created_at,usedAt:now,expiresAt:Number(one(event,'expiration')),reason}))return false
 members.addTeacher(caller)
 completeClaim(config.recommendationsFile,event.id,caller)
 return true
}
export function redeemCorePromotion(config,input,url,members,caller,now=Math.floor(Date.now()/1000)){
 if(!members.isTeacher(caller)||!validPromotion(input,url,members,now))return false
 const event=copyEvent(input)
 if(!claimEvent(config.recommendationsFile,event,caller,{kind:'promotion',coreMember:event.pubkey,createdAt:event.created_at,usedAt:now,expiresAt:Number(one(event,'expiration'))}))return false
 members.addCoreMember(caller)
 completeClaim(config.recommendationsFile,event.id,caller)
 return true
}
