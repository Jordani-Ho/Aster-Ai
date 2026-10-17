import { expect, it, afterEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity, generatePhrase } from '../identity'
import { openStore, type LocalStore } from '../store'
import type { Event } from 'nostr-tools/pure'
import { createBackupManager, decodeBackupFile, type BackupRelay } from './index'
const phrase='leader monkey parrot ring guide accident before fence cannon height naive bean'
const identity=()=>createIdentity(phrase,'english')
class MemoryRelay implements BackupRelay {
 online=true;events:Event[]=[]
 async list(owner:string){if(!this.online)throw Error('offline');return this.events.filter(e=>e.pubkey===owner)}
 async publish(event:Event){if(!this.online)throw Error('offline');const slot=Object.fromEntries(event.tags).d;this.events=this.events.filter(e=>!(e.pubkey===event.pubkey&&Object.fromEntries(e.tags).d===slot));this.events.push(JSON.parse(JSON.stringify(event)))}
}
const handles:LocalStore[]=[]
async function store(factory=new IDBFactory(),name=crypto.randomUUID(),who=identity()){const value=await openStore(who,{factory,name});handles.push(value);return value}
afterEach(()=>handles.splice(0).forEach(handle=>handle.close()))
it('1备份后清空数据库，助记词在新库恢复；2连续五次只保留最近三份；照片不进中继',async()=>{
 const factory=new IDBFactory(),name=crypto.randomUUID(),relay=new MemoryRelay(),source=await store(factory,name),key=crypto.randomUUID(),photoKey=crypto.randomUUID()
 await source.put('notes',key,{text:'SYNTHETIC_PRIVATE_RECORD'});await source.put('photos',photoKey,new Uint8Array([1,2,255]))
 const manager=createBackupManager({identity:identity(),store:source,relay})
 for(let n=1;n<=5;n++){await source.put('notes',key,{text:'SYNTHETIC_PRIVATE_RECORD',n});await manager.backupNow(new Date(2026,9,n,12))}
 expect(relay.events).toHaveLength(3)
 expect(JSON.stringify(relay.events)).not.toContain('SYNTHETIC_PRIVATE_RECORD')
 manager.close();source.close()
 await new Promise<void>((resolve,reject)=>{const request=factory.deleteDatabase(name);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error)})
 const restored=await store(factory,name);const recovery=createBackupManager({identity:identity(),store:restored,relay})
 await recovery.restoreLatest()
 expect(await restored.get('notes',key)).toEqual({text:'SYNTHETIC_PRIVATE_RECORD',n:5})
 expect(await restored.get('photos',photoKey)).toBeUndefined()
 manager.close();recovery.close()
})
it('3别人的助记词不能解密；4加密文件在另一个浏览器环境恢复含照片',async()=>{
 const relay=new MemoryRelay(),source=await store(),key=crypto.randomUUID()
 await source.put('photos',key,new Uint8Array([0,255,18,128]))
 const manager=createBackupManager({identity:identity(),store:source,relay}),file=await manager.exportFile()
 const other=createIdentity(generatePhrase('english'),'english')
 expect(()=>decodeBackupFile(file,other)).toThrow()
 const forgedOwner={...JSON.parse(file),owner:other.publicKey}
 expect(()=>decodeBackupFile(JSON.stringify(forgedOwner),other)).toThrow()
 const target=await store(new IDBFactory())
 const recovery=createBackupManager({identity:identity(),store:target,relay})
 await recovery.restoreFile(file)
 expect(await target.get('photos',key)).toEqual(new Uint8Array([0,255,18,128]))
 manager.close();recovery.close()
})
it('5中继失败状态持久化，下次打开重试成功；同一天不会重复自动备份',async()=>{
 const relay=new MemoryRelay(),source=await store();await source.put('notes',crypto.randomUUID(),{text:'SYNTHETIC'})
 relay.online=false
 const first=createBackupManager({identity:identity(),store:source,relay})
 await expect(first.ensureDaily(new Date(2026,9,16,10))).rejects.toThrow()
 expect((await first.status()).result).toBe('failed');first.close()
 relay.online=true
 const next=createBackupManager({identity:identity(),store:source,relay})
 await next.ensureDaily(new Date(2026,9,16,11))
 expect((await next.status()).result).toBe('success');expect(relay.events).toHaveLength(1)
 await next.ensureDaily(new Date(2026,9,16,12));expect(relay.events).toHaveLength(1)
 next.close()
})
it('空白新设备先恢复已有备份，不上传空快照覆盖它；恢复篡改文件不改现有数据',async()=>{
 const relay=new MemoryRelay(),source=await store(),key=crypto.randomUUID()
 await source.put('notes',key,{text:'RECOVERY_SENTINEL'})
 const first=createBackupManager({identity:identity(),store:source,relay});await first.backupNow()
 const blank=await store(),next=createBackupManager({identity:identity(),store:blank,relay})
 await next.ensureDaily();expect(await blank.get('notes',key)).toEqual({text:'RECOVERY_SENTINEL'});expect(relay.events).toHaveLength(1)
 const file=JSON.parse(await first.exportFile());file.ciphertext='invalid'
 await expect(next.restoreFile(JSON.stringify(file),true)).rejects.toThrow()
 expect(await blank.get('notes',key)).toEqual({text:'RECOVERY_SENTINEL'})
 first.close();next.close()
})
it('仅有本机照片时也不会当空设备自动覆盖；每月提示在文件生成后清除',async()=>{
 const relay=new MemoryRelay(),source=await store(),key=crypto.randomUUID()
 await source.put('notes',key,{text:'REMOTE'})
 const first=createBackupManager({identity:identity(),store:source,relay});await first.backupNow(new Date(2026,9,15))
 const local=await store(),photo=crypto.randomUUID();await local.put('photos',photo,new Uint8Array([1,2,3]))
 const second=createBackupManager({identity:identity(),store:local,relay});await second.ensureDaily(new Date(2026,9,16))
 expect(await local.get('photos',photo)).toEqual(new Uint8Array([1,2,3]));expect(await local.get('notes',key)).toBeUndefined()
 expect(await second.monthlyFileDue()).toBe(true);await second.exportFile();expect(await second.monthlyFileDue()).toBe(false)
 first.close();second.close()
})
import { finalizeEvent } from 'nostr-tools/pure'
import { v2 } from 'nostr-tools/nip44'
it('恢复依次跳过最新解密失败及次新记录校验失败，回退到第三份；全坏时不改本地',async()=>{
 const who=identity(),relay=new MemoryRelay(),source=await store(),key=crypto.randomUUID()
 await source.put('notes',key,{text:'VALID_OLDEST'})
 const first=createBackupManager({identity:who,store:source,relay});await first.backupNow(new Date(2026,9,10))
 const invalidArchive=await source.exportEncrypted();invalidArchive.records[0].ct='invalid'
 const sign=(slot:string,at:number,content:string)=>finalizeEvent({kind:30078,created_at:at,tags:[['d',slot]],content},who.privateKey)
 const base=relay.events[0].created_at
 await relay.publish(sign('aster.backup.1',base+1,v2.encrypt(JSON.stringify(invalidArchive),v2.utils.getConversationKey(who.privateKey,who.publicKey))))
 await relay.publish(sign('aster.backup.2',base+2,'invalid ciphertext'))
 const target=await store(),manager=createBackupManager({identity:identity(),store:target,relay})
 await manager.restoreLatest()
 expect(await target.get('notes',key)).toEqual({text:'VALID_OLDEST'})
 expect((await manager.status()).lastSuccess).toBe(new Date(base*1000).toISOString())
 relay.events[0]=sign('aster.backup.0',base,'also invalid')
 await expect(manager.restoreLatest(true)).rejects.toThrow('所有中继备份均无法恢复')
 expect(await target.get('notes',key)).toEqual({text:'VALID_OLDEST'})
 first.close();manager.close()
})
