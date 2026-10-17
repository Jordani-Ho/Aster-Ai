import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure'
import { createTransport, openMessage, wrapMessage, type Socket, type Message } from './index'
import { validSignature, expiration } from './crypto'
const student=generateSecretKey(),teacher=generateSecretKey(),third=generateSecretKey(),outsider=generateSecretKey()
const pub=(key:Uint8Array)=>getPublicKey(key)
class MemoryRelay {
 events=new Map<string,Event>();clients=new Set<MemorySocket>();online=true
 members=new Set([pub(student),pub(teacher),pub(third)])
 socket=(_url:string):Socket=>new MemorySocket(this)
 disconnect(){this.online=false;for(const client of this.clients)client.close()}
}
class MemorySocket implements Socket {
 readyState=0;onopen:Socket['onopen']=null;onclose:Socket['onclose']=null;onerror:Socket['onerror']=null;onmessage:Socket['onmessage']=null
 challenge=crypto.randomUUID();owner='';sub=false
 constructor(private relay:MemoryRelay){relay.clients.add(this);queueMicrotask(()=>{if(!relay.online){this.close();return}this.readyState=1;this.onopen?.({});this.emit(['AUTH',this.challenge])})}
 emit(value:unknown){queueMicrotask(()=>{if(this.readyState===1)this.onmessage?.({data:JSON.stringify(value)})})}
 send(data:string){
 if(!this.relay.online||this.readyState!==1)throw Error('offline')
 const [cmd,first,filter]=JSON.parse(data)
 if(cmd==='AUTH'){
 const e=first as Event,tags=Object.fromEntries(e.tags)
 const valid=validSignature(e)&&e.kind===22242&&this.relay.members.has(e.pubkey)&&tags.challenge===this.challenge&&tags.relay==='ws://localhost/'&&Math.abs(Date.now()/1000-e.created_at)<600
 if(valid)this.owner=e.pubkey
 this.emit(['OK',e.id,valid,valid?'':'restricted: member required']);return
 }
 if(!this.owner){this.emit(cmd==='REQ'?['CLOSED',first,'auth-required:']:['OK',first.id,false,'auth-required:']);return}
 if(cmd==='REQ'){
 this.sub=true
 if(filter['#p']?.length!==1||filter['#p'][0]!==this.owner){this.emit(['CLOSED',first,'restricted: own inbox only']);return}
 for(const e of this.relay.events.values())if(expiration(e)>Date.now()/1000&&e.tags.some(t=>t[0]==='p'&&t[1]===this.owner))this.emit(['EVENT','inbox',e])
 this.emit(['EOSE','inbox']);return
 }
 if(cmd==='EVENT'){
 const e=first as Event
 if(!validSignature(e)||expiration(e)<=Date.now()/1000){this.emit(['OK',e.id,false,'invalid:']);return}
 if(!this.relay.events.has(e.id)){
 this.relay.events.set(e.id,JSON.parse(JSON.stringify(e)))
 for(const client of this.relay.clients)if(client.sub&&e.tags.some(t=>t[0]==='p'&&t[1]===client.owner))client.emit(['EVENT','inbox',e])
 }
 this.emit(['OK',e.id,true,''])
 }
 }
 close(){if(this.readyState===3)return;this.readyState=3;this.relay.clients.delete(this);this.onclose?.({})}
}
const handles:ReturnType<typeof createTransport>[]=[]
function node(relay:MemoryRelay,key:Uint8Array,received:Message[]){const transport=createTransport({privateKey:key,relays:['ws://localhost/'],socket:relay.socket,onMessage:message=>{received.push(message)}});handles.push(transport);transport.start();return transport}
const tick=()=>vi.advanceTimersByTimeAsync(10)
afterEach(()=>{handles.splice(0).forEach(handle=>handle.close());vi.useRealTimers()})
it('1 ping可解密；2中继仅见随机外层发件人、随机时间；默认过期不泄露真实发送秒',async()=>{
 vi.useFakeTimers();const relay=new MemoryRelay(),received:Message[]=[]
 const a=node(relay,student,[]);node(relay,teacher,received);await tick()
 const pending=a.send(pub(teacher),{type:'ping',version:1,payload:{text:'SYNTHETIC_PRIVATE_PING'}});await tick();await pending
 expect(received).toHaveLength(1);expect(received[0].sender).toBe(pub(student));expect(received[0].envelope.payload).toEqual({text:'SYNTHETIC_PRIVATE_PING'})
 const outer=[...relay.events.values()].find(e=>e.tags.some(t=>t[0]==='p'&&t[1]===pub(teacher)))!
 expect(JSON.stringify(outer)).not.toContain('SYNTHETIC_PRIVATE_PING');expect(outer.pubkey).not.toBe(pub(student))
 expect(outer.created_at).toBeLessThan(received[0].at);expect(expiration(outer)-outer.created_at).toBe(30*86400)
})
it('3非成员不能读写，成员只能收到本人包裹',async()=>{
 vi.useFakeTimers();const relay=new MemoryRelay(),bad:Message[]=[],other:Message[]=[],received:Message[]=[]
 const a=node(relay,student,[]);node(relay,teacher,received);node(relay,third,other);node(relay,outsider,bad);await tick()
 const pending=a.send(pub(teacher),{type:'ping',version:1,payload:'SYNTHETIC'});await tick();await pending
 expect(received).toHaveLength(1);expect(other).toHaveLength(0);expect(bad).toHaveLength(0)
})
it('4断线30秒期间排队，恢复后重发不重复；多次sync不重复',async()=>{
 vi.useFakeTimers();const relay=new MemoryRelay(),received:Message[]=[]
 const a=node(relay,student,[]),b=node(relay,teacher,received);await tick();relay.disconnect()
 const pending=a.send(pub(teacher),{type:'ping',version:1,payload:'QUEUED'})
 await vi.advanceTimersByTimeAsync(30000);expect(received).toHaveLength(0)
 relay.online=true;await vi.advanceTimersByTimeAsync(1100);await pending
 b.sync();b.sync();await tick();expect(received).toHaveLength(1)
})
it('5过期包裹不返回；6第三人不能解密，篡改签名和内部消息均拒绝',async()=>{
 vi.useFakeTimers();const relay=new MemoryRelay(),received:Message[]=[]
 const packet=wrapMessage(student,pub(teacher),{type:'ping',version:1,payload:'PRIVATE'})
 const outer=packet.events[0]
 expect(()=>openMessage(outer,third)).toThrow()
 expect(()=>openMessage({...outer,sig:'0'.repeat(128)},teacher)).toThrow()
 for(const e of packet.events)relay.events.set(e.id,e)
 await vi.advanceTimersByTimeAsync(31*86400*1000);node(relay,teacher,received);await tick();expect(received).toHaveLength(0)
})
it('同秒相同内容是两个独立消息；拒绝非法信封和超过2MB包裹',()=>{
 const one=wrapMessage(student,pub(teacher),{type:'ping',version:1,payload:'same'})
 const two=wrapMessage(student,pub(teacher),{type:'ping',version:1,payload:'same'})
 expect(one.id).not.toBe(two.id)
 expect(()=>wrapMessage(student,pub(teacher),{type:'ping',version:1,payload:NaN})).toThrow()
 expect(()=>wrapMessage(student,pub(teacher),{type:'ping',version:1,payload:'x'.repeat(2*1024*1024)})).toThrow()
})
