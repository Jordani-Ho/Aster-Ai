import {finalizeEvent,getEventHash,verifyEvent,type Event} from 'nostr-tools/pure'
import type {Identity} from '../identity'
import {communityBackupRelay} from '../backup/relay'
import {sealIdentity,openIdentity,authenticatePasskey,type SealedIdentity} from './passkey'
export async function identityEvents(relays:string[],owner:string):Promise<Event[]>{
 const groups=await Promise.all(relays.map(input=>new Promise<Event[]>((resolve,reject)=>{
  const url=new URL(input);if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))){reject(Error('备份地址无效'));return}
  const socket=new WebSocket(url.href),events:Event[]=[];let done=false
  const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);socket.onclose=null;socket.close();error?reject(error):resolve(events)}
  const timer=setTimeout(()=>finish(Error('备份连接超时')),10000)
  socket.onopen=()=>socket.send(JSON.stringify(['REQ','identity',{kinds:[30078],authors:[owner],'#d':['aster.identity'],limit:1}]))
  socket.onerror=()=>finish(Error('备份连接失败'));socket.onclose=()=>finish(Error('备份连接中断'))
  socket.onmessage=({data})=>{try{if(typeof data!=='string'||data.length>16384){finish(Error('备份回复无效'));return}const frame=JSON.parse(data);if(frame[0]==='EVENT'&&frame[1]==='identity'){if(events.length>=4)throw Error();const e=frame[2] as Event;if(e.kind===30078&&e.pubkey===owner&&e.tags.filter(t=>t[0]==='d').length===1&&e.tags.some(t=>t.length===2&&t[0]==='d'&&t[1]==='aster.identity')&&getEventHash(e)===e.id&&verifyEvent(e))events.push(e)}else if(frame[0]==='EOSE'&&frame[1]==='identity')finish();else if(frame[0]==='CLOSED')finish(Error('备份不可读取'))}catch{finish(Error('备份回复无效'))}}
 })))
 return [...new Map(groups.flat().map(e=>[e.id,e])).values()].sort((a,b)=>b.created_at-a.created_at||a.id.localeCompare(b.id))
}
export async function publishIdentity(identity:Identity,key:CryptoKey,relays:string[]){
 if(!relays.length)throw Error('请先配置社区备份')
 const content=JSON.stringify(await sealIdentity(identity,key)),events=await identityEvents(relays,identity.publicKey)
 const event=finalizeEvent({kind:30078,created_at:Math.max(Math.floor(Date.now()/1000),...events.map(e=>e.created_at+1)),tags:[['d','aster.identity']],content},identity.privateKey)
 const relay=communityBackupRelay(identity,relays)
 try{await relay.publish(event)}finally{relay.close()}
}
export async function recoverPasskey(relays:string[]){
 const {key,owner}=await authenticatePasskey(),events=await identityEvents(relays,owner)
 for(const event of events){try{return {identity:await openIdentity(JSON.parse(event.content) as SealedIdentity,owner,key),key}}catch{}}
 throw Error('没有找到可恢复的备份，请检查是否使用了同一个手机账户。')
}
