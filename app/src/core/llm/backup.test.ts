import {it,expect} from 'vitest'
import {IDBFactory} from 'fake-indexeddb'
import {createIdentity} from '../identity'
import {openStore} from '../store'
import {createBackupManager,type BackupRelay} from '../backup'
import {savePersonalModel,loadPersonalModel} from './personal'
it('personal model is only encrypted storage, included in relay and file backups and restored without re-entry',async()=>{
 const identity=createIdentity('leader monkey parrot ring guide accident before fence cannon height naive bean','english'),factory=new IDBFactory(),store=await openStore(identity,{factory,name:crypto.randomUUID()})
 const events:any[]=[],relay:BackupRelay={list:async()=>events,publish:async e=>{events.push(e)}},manager=createBackupManager({identity,store,relay})
 const config={provider:'deepseek',baseUrl:'https://api.deepseek.com',model:'synthetic-model',apiKey:'SYNTHETIC_PRIVATE_ACCOUNT',testedAt:'2026-10-17T00:00:00Z'}
 try{
  await savePersonalModel(store,config);await manager.backupNow();const file=await manager.exportFile(),encrypted=JSON.stringify(await store.exportEncrypted())
  for(const text of [JSON.stringify(events),file,encrypted])expect(text).not.toContain(config.apiKey)
  const next={...config,apiKey:'SYNTHETIC_REPLACEMENT',testedAt:'2026-10-17T00:00:01Z'};await savePersonalModel(store,next);await manager.ensureDaily();expect(events).toHaveLength(2);await manager.ensureDaily();expect(events).toHaveLength(2)
  await store.delete('settings','personal-model');expect(await loadPersonalModel(store)).toBeNull();await manager.restoreLatest(true);expect(await loadPersonalModel(store)).toEqual(next)
  await store.delete('settings','personal-model');await manager.restoreFile(file,true);expect(await loadPersonalModel(store)).toEqual(config)
 }finally{manager.close();store.close();identity.privateKey.fill(0)}
})
