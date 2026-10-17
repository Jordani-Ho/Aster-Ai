import { expect,it,vi,afterEach } from 'vitest'
import { finalizeEvent,getPublicKey,generateSecretKey,verifyEvent } from 'nostr-tools/pure'
import { communityBackupRelay } from './relay'
import { createIdentity } from '../identity'
const identity=()=>createIdentity('leader monkey parrot ring guide accident before fence cannon height naive bean','english')
afterEach(()=>vi.useRealTimers())
it('备份WebSocket先完成NIP42，查询只带本人作者和三槽，发布等待OK',async()=>{
 const who=identity(),frames:unknown[][]=[]
 const factory=()=>{
 const socket={onmessage:null as ((event:{data:string})=>void)|null,onerror:null as (()=>void)|null,onclose:null as (()=>void)|null,close:()=>{},send:(raw:string)=>{
 const frame=JSON.parse(raw);frames.push(frame)
 if(frame[0]==='AUTH'){
 expect(verifyEvent(frame[1])).toBe(true);expect(frame[1].pubkey).toBe(who.publicKey);expect(Object.fromEntries(frame[1].tags).challenge).toBe('SYNTHETIC_CHALLENGE');expect(Object.fromEntries(frame[1].tags).relay).toBe('ws://localhost/')
 queueMicrotask(()=>socket.onmessage?.({data:JSON.stringify(['OK',frame[1].id,true,''])}))
 }else if(frame[0]==='REQ'){
 expect(frame[2].authors).toEqual([who.publicKey]);expect(frame[2]['#d']).toHaveLength(3)
 queueMicrotask(()=>socket.onmessage?.({data:JSON.stringify(['EOSE','backup'])}))
 }else if(frame[0]==='EVENT')queueMicrotask(()=>socket.onmessage?.({data:JSON.stringify(['OK',frame[1].id,true,''])}))
 }}
 queueMicrotask(()=>socket.onmessage?.({data:JSON.stringify(['AUTH','SYNTHETIC_CHALLENGE'])}));return socket as unknown as WebSocket
 }
 const relay=communityBackupRelay(who,['ws://localhost'],factory)
 expect(await relay.list(who.publicKey)).toEqual([])
 const event=finalizeEvent({kind:30078,created_at:Math.floor(Date.now()/1000),tags:[['d','aster.backup.0']],content:'SYNTHETIC_ENCRYPTED'},who.privateKey)
 await relay.publish(event)
 await expect(relay.list(getPublicKey(generateSecretKey()))).rejects.toThrow()
 expect(frames.map(frame=>frame[0])).toEqual(['AUTH','REQ','AUTH','EVENT']);relay.close()
})
it('无EOSE不能误当空中继；未配置不能声称成功；AUTH失败拒绝',async()=>{
 vi.useFakeTimers();const who=identity()
 const silent=()=>({onmessage:null,onerror:null,onclose:null,send:()=>{},close:()=>{}} as unknown as WebSocket)
 const relay=communityBackupRelay(who,['ws://localhost/'],silent)
 const pending=expect(relay.list(who.publicKey)).rejects.toThrow('超时');await vi.advanceTimersByTimeAsync(10001);await pending;relay.close()
 await expect(communityBackupRelay(who,[]).list(who.publicKey)).rejects.toThrow('未配置')
})

it('AUTH拒绝时不得发送REQ或EVENT',async()=>{
 const who=identity(),frames:unknown[][]=[]
 const factory=()=>{
 const socket={onmessage:null as ((event:{data:string})=>void)|null,onerror:null,onclose:null,close:()=>{},send:(raw:string)=>{const frame=JSON.parse(raw);frames.push(frame);queueMicrotask(()=>socket.onmessage?.({data:JSON.stringify(['OK',frame[1].id,false,'restricted:'])}))}}
 queueMicrotask(()=>socket.onmessage?.({data:JSON.stringify(['AUTH','SYNTHETIC_CHALLENGE'])}));return socket as unknown as WebSocket
 }
 const relay=communityBackupRelay(who,['ws://localhost/'],factory)
 await expect(relay.list(who.publicKey)).rejects.toThrow('鉴权失败');expect(frames.map(frame=>frame[0])).toEqual(['AUTH']);relay.close()
})
