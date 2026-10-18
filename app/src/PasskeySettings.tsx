import {useEffect,useState} from 'react'
import type {Identity} from './core/identity'
import type {LocalStore} from './core/store'
import {openStore,protectStore,storeProtectionEnabled} from './core/store'
import {createBackupManager} from './core/backup'
import {communityBackupRelay} from './core/backup/relay'
import {enrollPasskey,authenticatePasskey,PrfUnavailable} from './core/onboarding/passkey'
import {publishIdentity} from './core/onboarding/identity-relay'
export async function configuredRelays(store:LocalStore,defaults:string[]){const row=(await store.list('backup-config'))[0]?.value as {relays?:string[]}|undefined;return row?.relays??defaults}
export function PasskeySettings({identity,store,defaults}:{identity:Identity;store:LocalStore;defaults:string[]}){
 const [protectedNow,setProtected]=useState(false),[unsupported,setUnsupported]=useState(!globalThis.PublicKeyCredential||!navigator.credentials),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
 useEffect(()=>{void storeProtectionEnabled().then(setProtected).catch(()=>{})},[store])
 return <section><h3>刷脸保护</h3><button role="switch" aria-checked={protectedNow} disabled={unsupported||busy} onClick={()=>{setBusy(true);void(async()=>{try{
  if(protectedNow){const {owner}=await authenticatePasskey();if(owner!==identity.publicKey)throw Error();const reopened=await openStore(identity);reopened.close();setProtected(false);setMessage('已关闭刷脸保护。')}
  else{const {key}=await enrollPasskey(identity),relays=await configuredRelays(store,defaults);await publishIdentity(identity,key,relays);const relay=communityBackupRelay(identity,relays),manager=createBackupManager({identity,store,relay});try{await manager.backupNow()}finally{manager.close();relay.close()};await protectStore(identity,key);setProtected(true);setMessage('已开启。换手机时使用同一个手机账户，可刷脸找回中继中的备份。照片仍需文件备份。')}
 }catch(error){if(error instanceof PrfUnavailable){setUnsupported(true);setMessage('这台手机暂不支持，其他功能照常使用。')}else setMessage('操作未完成，现有资料和其他功能不受影响。')}finally{setBusy(false)}})()}}>用刷脸保护并自动备份</button>{unsupported&&<p>这台手机暂不支持</p>}{message&&<p role="status">{message}</p>}</section>
}
