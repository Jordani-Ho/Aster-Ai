import {it,expect} from 'vitest'
import {IDBFactory} from 'fake-indexeddb'
import {createIdentity} from '../identity'
import {openStore,resumeStore,protectStore,PasskeyUnlockRequired} from '../store'
import {derivePrfKey,sealIdentity,openIdentity,enrollPasskey} from './passkey'
const identity=createIdentity('leader monkey parrot ring guide accident before fence cannon height naive bean','english')
it('PRF protects local identity without persisting a usable device key and wrong output cannot unlock',async()=>{
 const options={factory:new IDBFactory(),name:crypto.randomUUID()},store=await openStore(identity,options),key=await derivePrfKey(new Uint8Array(32).fill(7))
 await store.put('notes','synthetic',{text:'SYNTHETIC'});await protectStore(identity,key,options);store.close()
 await expect(resumeStore(options)).rejects.toBeInstanceOf(PasskeyUnlockRequired)
 await expect(resumeStore({...options,unlockKey:await derivePrfKey(new Uint8Array(32).fill(8))})).rejects.toThrow()
 const restored=await resumeStore({...options,unlockKey:key});expect(await restored?.store.get('notes','synthetic')).toEqual({text:'SYNTHETIC'});restored?.store.close()
})
it('identity ciphertext authenticates author and contents, never stores clear authority',async()=>{
 const key=await derivePrfKey(new Uint8Array(32).fill(7)),sealed=await sealIdentity(identity,key)
 expect(JSON.stringify(sealed)).not.toContain(JSON.stringify([...identity.privateKey]))
 expect((await openIdentity(sealed,identity.publicKey,key)).publicKey).toBe(identity.publicKey)
 await expect(openIdentity(sealed,'b'.repeat(64),key)).rejects.toThrow()
})
it('registration with no PRF result must try authentication; capability enabled flag alone never enables protection',async()=>{
 const fake=(first?:ArrayBuffer)=>({rawId:new Uint8Array([1,2]).buffer,response:{userHandle:Uint8Array.from(identity.publicKey.match(/../g)!.map(v=>parseInt(v,16))).buffer},getClientExtensionResults:()=>({prf:{enabled:true,...(first?{results:{first}}:{})}})})
 const api={create:async()=>fake(),get:async()=>fake(new Uint8Array(32).fill(9).buffer)} as unknown as CredentialsContainer
 expect((await enrollPasskey(identity,api,'localhost')).key.algorithm.name).toBe('AES-GCM')
 await expect(enrollPasskey(identity,{...api,get:async()=>fake()} as unknown as CredentialsContainer,'localhost')).rejects.toThrow('这台手机暂不支持')
})
