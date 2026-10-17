import { finalizeEvent, getEventHash, verifyEvent, type Event } from 'nostr-tools/pure'
import { v2 } from 'nostr-tools/nip44'
import type { Identity } from '../identity'
import type { EncryptedExport, LocalStore } from '../store'
export const BACKUP_KIND=30078
export const BACKUP_SLOTS=['aster.backup.0','aster.backup.1','aster.backup.2']
export interface BackupRelay { list(owner:string):Promise<Event[]>;publish(event:Event):Promise<void> }
export interface BackupStatus { result:'never'|'success'|'failed'|'restored';lastAttempt?:string;lastSuccess?:string;lastFile?:string;lastRestore?:string;error?:string }
export interface BackupFile { format:'aster-backup';version:1;owner:string;ciphertext:string }
const MAX_EVENT_BYTES=2*1024*1024
const day=(at:Date)=>[at.getFullYear(),at.getMonth(),at.getDate()].join('-')
const month=(at:Date)=>[at.getFullYear(),at.getMonth()].join('-')
function decode(ciphertext:string,identity:Pick<Identity,'privateKey'|'publicKey'>):EncryptedExport {
 return JSON.parse(v2.decrypt(ciphertext,v2.utils.getConversationKey(identity.privateKey,identity.publicKey))) as EncryptedExport
}
export function decodeBackupFile(text:string,identity:Pick<Identity,'privateKey'|'publicKey'>):EncryptedExport {
 const file=JSON.parse(text) as BackupFile
 if(file.format!=='aster-backup'||file.version!==1||file.owner!==identity.publicKey||typeof file.ciphertext!=='string')throw Error('备份文件或身份不匹配')
 const archive=decode(file.ciphertext,identity)
 if(archive.owner!==identity.publicKey)throw Error('备份身份不匹配')
 return archive
}
function validEvent(event:Event,owner:string):boolean {
 try{const clean=JSON.parse(JSON.stringify(event));return clean.kind===BACKUP_KIND&&clean.pubkey===owner&&clean.tags.filter((tag:string[])=>tag[0]==='d').length===1&&BACKUP_SLOTS.includes(Object.fromEntries(clean.tags).d)&&new TextEncoder().encode(JSON.stringify(clean)).length<=MAX_EVENT_BYTES&&getEventHash(clean)===clean.id&&verifyEvent(clean)}catch{return false}
}
export function createBackupManager({identity,store,relay}:{identity:Identity;store:LocalStore;relay:BackupRelay}) {
 const who={publicKey:identity.publicKey,privateKey:new Uint8Array(identity.privateKey)}
 let closed=false,busy=false
 async function status():Promise<BackupStatus>{const records=await store.list('backup-status');return records.length?records[0].value as unknown as BackupStatus:{result:'never'}}
 async function save(value:BackupStatus){const records=await store.list('backup-status');await store.put('backup-status',records[0]?.key??crypto.randomUUID(),JSON.parse(JSON.stringify(value)))}
 const active=()=>{if(closed)throw Error('备份会话已关闭')}
 async function snapshots(){
  const events=await relay.list(who.publicKey);active()
  const ordered=events.filter(event=>validEvent(event,who.publicKey)).sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id))
  const latest=new Map<string,Event>()
  for(const event of ordered){const slot=Object.fromEntries(event.tags).d;if(!latest.has(slot))latest.set(slot,event)}
  return [...latest.values()]
 }
 async function exclusive<T>(job:()=>Promise<T>):Promise<T>{active();if(busy)throw Error('备份正在进行');busy=true;try{return await job()}finally{busy=false;if(closed)who.privateKey.fill(0)}}
 async function backup(now:Date,known?:Event[]){
  const prior=await status(),attempt=now.toISOString()
  try{
   const events=known??await snapshots(),archive=await store.exportEncrypted()
   archive.records=archive.records.filter(record=>record.c!=='pilot-metrics')
   active()
   const used=new Set(events.map(event=>Object.fromEntries(event.tags).d))
   const slot=BACKUP_SLOTS.find(value=>!used.has(value))??Object.fromEntries(events[events.length-1].tags).d
   const event=finalizeEvent({kind:BACKUP_KIND,created_at:Math.max(Math.floor(now.getTime()/1000),...events.map(value=>value.created_at+1)),tags:[['d',slot]],content:v2.encrypt(JSON.stringify(archive),v2.utils.getConversationKey(who.privateKey,who.publicKey))},who.privateKey)
   if(new TextEncoder().encode(JSON.stringify(event)).length>MAX_EVENT_BYTES)throw Error('结构化备份超过中继2MB上限，请导出备份文件')
   active();await relay.publish(event);active()
   await save({...prior,result:'success',lastAttempt:attempt,lastSuccess:attempt,error:undefined})
  }catch(error){if(!closed)await save({...prior,result:'failed',lastAttempt:attempt,error:error instanceof Error&&error.message.includes('2MB')?error.message:'中继备份失败，下次打开应用会重试'});throw error}
 }
 async function restore(events:Event[],replace:boolean){
  if(!events.length)throw Error('未找到可用的中继备份')
  // 覆盖授权属于本地操作条件，不能误当作快照损坏而回退。
  if(!replace&&(await store.exportEncrypted({includeBinary:true})).records.length)throw Error('已有本地数据，必须显式传入 replace: true')
  for(const event of events){
   active()
   try{
    const archive=decode(event.content,who)
    if(archive.includesBinary||archive.records.some(record=>record.bin))throw Error('中继备份不允许包含照片等二进制资料')
    active();await store.importEncrypted(archive,{replace})
   }catch{active();continue}
   active()
   const prior=await status()
   await save({...prior,result:'restored',lastRestore:new Date().toISOString(),lastSuccess:new Date(event.created_at*1000).toISOString(),error:undefined})
   return
  }
  throw Error('所有中继备份均无法恢复，本地数据未更改')
 }

 return {
  status,
  backupNow:(now=new Date())=>exclusive(()=>backup(now)),
  ensureDaily:(now=new Date())=>exclusive(async()=>{
   const prior=await status()
   if(prior.result!=='failed'&&prior.lastSuccess&&day(new Date(prior.lastSuccess))===day(now))return
   try{
    const events=await snapshots(),archive=await store.exportEncrypted({includeBinary:true})
    const business=archive.records.filter(record=>!['backup-status','backup-config'].includes(record.c))
    if(!business.length&&events.length){await restore(events,true);return}
    await backup(now,events)
   }catch(error){if(!closed&&(await status()).result!=='failed')await save({...prior,result:'failed',lastAttempt:now.toISOString(),error:'中继备份失败，下次打开应用会重试'});throw error}
  }),
  restoreLatest:(replace=false)=>exclusive(async()=>restore(await snapshots(),replace)),
  exportFile:()=>exclusive(async()=>{
   const archive=await store.exportEncrypted({includeBinary:true});active()
   const file:BackupFile={format:'aster-backup',version:1,owner:who.publicKey,ciphertext:v2.encrypt(JSON.stringify(archive),v2.utils.getConversationKey(who.privateKey,who.publicKey))}
   const prior=await status();await save({...prior,lastFile:new Date().toISOString()})
   return JSON.stringify(file)
  }),
  restoreFile:(text:string,replace=false)=>exclusive(async()=>{
   const archive=decodeBackupFile(text,who);active();await store.importEncrypted(archive,{replace});active()
   const prior=await status();await save({...prior,result:'restored',lastRestore:new Date().toISOString(),error:undefined})
  }),
  monthlyFileDue:async(now=new Date())=>{const value=await status();return !value.lastFile||month(new Date(value.lastFile))!==month(now)},
  close(){closed=true;if(!busy)who.privateKey.fill(0)},
 }
}
