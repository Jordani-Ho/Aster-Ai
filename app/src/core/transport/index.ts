import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure'
import { authTemplate, expiration, MAX_EVENT_BYTES, openMessage, wrapMessage, type Envelope, type Message } from './crypto'
export { wrapMessage, openMessage, TTL_SECONDS, MAX_EVENT_BYTES } from './crypto'
export type { Envelope, Message } from './crypto'
export interface Socket {
 readyState:number; send(data:string):void; close():void
 onopen:((event:unknown)=>void)|null; onclose:((event:unknown)=>void)|null; onerror:((event:unknown)=>void)|null; onmessage:((event:{data:unknown})=>void)|null
}
export interface TransportOptions {
 privateKey:Uint8Array; relays:string[]; socket?:(url:string)=>Socket
 onMessage:(message:Message)=>void|Promise<void>; onStatus?:(status:'connecting'|'ready'|'offline'|'rejected'|'invalid-message')=>void
 retryMs?:number
}
interface Link {url:string; socket:Socket; ready:boolean; authId?:string; timer?:ReturnType<typeof setTimeout>}
interface Pending {id:string;events:Event[];acked:Set<string>;resolve:(id:string)=>void;reject:(error:Error)=>void}
export function createTransport(options:TransportOptions) {
 const key=new Uint8Array(options.privateKey),owner=getPublicKey(key)
 const urls=[...new Set(options.relays.map(input=>{const url=new URL(input);if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('中继需要WSS');return url.href}))]
 if(!urls.length)throw Error('至少配置一个社区中继')
 const links=new Map<string,Link>(),pending=new Map<string,Pending>(),seen=new Set<string>()
 const retries=new Set<ReturnType<typeof setTimeout>>()
 let stopped=false,started=false,processing=Promise.resolve()
 const report=(status:Parameters<NonNullable<TransportOptions['onStatus']>>[0])=>options.onStatus?.(status)
 const sendFrame=(link:Link,value:unknown)=>{try{link.socket.send(JSON.stringify(value))}catch{link.socket.close();reconnect(link)}}
 function flush(link:Link) {
  if(!link.ready)return
  for(const task of pending.values())for(const event of task.events){
   if(expiration(event)<=Date.now()/1000){pending.delete(task.id);task.reject(Error('待发消息已过期'));break}
   if(!task.acked.has(event.id))sendFrame(link,['EVENT',event])
  }
 }
 function reconnect(link:Link) {
  if(stopped||link.timer||links.get(link.url)!==link)return
  link.ready=false;report('offline')
  link.timer=setTimeout(()=>{link.timer=undefined;if(!stopped)connect(link.url)},options.retryMs??1000)
 }
 function connect(url:string) {
  if(stopped)return
  report('connecting')
  let socket:Socket
  try{socket=options.socket?.(url)??new WebSocket(url) as unknown as Socket}catch{const old=links.get(url);if(old)reconnect(old);else {const timer=setTimeout(()=>{retries.delete(timer);connect(url)},options.retryMs??1000);retries.add(timer)}return}
  const link:Link={url,socket,ready:false};links.set(url,link)
  socket.onopen=()=>{}
  socket.onerror=()=>{socket.close();reconnect(link)}
  socket.onclose=()=>reconnect(link)
  socket.onmessage=({data})=>{
   if(stopped||links.get(url)!==link||typeof data!=='string'||new TextEncoder().encode(data).length>MAX_EVENT_BYTES+1024)return
   try{
    const frame:unknown[]=JSON.parse(data)
    if(!Array.isArray(frame))return
    if(frame[0]==='AUTH'&&typeof frame[1]==='string'){
     link.ready=false
     const auth=finalizeEvent(authTemplate(url,frame[1]),key);link.authId=auth.id;sendFrame(link,['AUTH',auth])
    }else if(frame[0]==='OK'&&typeof frame[1]==='string'){
     if(frame[1]===link.authId){
      if(frame[2]!==true){report('rejected');socket.close();return}
      link.ready=true;report('ready');sendFrame(link,['REQ','inbox',{kinds:[1059],'#p':[owner]}]);flush(link)
     }else if(frame[2]===true){
      for(const task of pending.values())if(task.events.some(event=>event.id===frame[1])){
       task.acked.add(frame[1]);if(task.events.every(event=>task.acked.has(event.id))){pending.delete(task.id);task.resolve(task.id)}
      }
     }else if(typeof frame[3]==='string'&&frame[3].startsWith('auth-required:')){socket.close();reconnect(link)}
     else{for(const task of pending.values())if(task.events.some(event=>event.id===frame[1])){pending.delete(task.id);task.reject(Error('中继拒绝消息'))}}
    }else if(frame[0]==='EVENT'&&frame[1]==='inbox'&&link.ready){
     const raw=frame[2] as Event
     processing=processing.then(async()=>{
      if(stopped)return
      let message:Message;try{message=openMessage(raw,key)}catch{report('invalid-message');return}
      if(seen.has(message.id))return
      try{await options.onMessage(message);seen.add(message.id)}catch{report('invalid-message')}
     })
    }
   }catch{report('invalid-message')}
  }
 }
 return {
  start(){if(started)return;started=true;urls.forEach(connect)},
  send(recipient:string,envelope:Envelope):Promise<string>{
   if(stopped)return Promise.reject(Error('中继连接已关闭'))
   const packet=wrapMessage(key,recipient,envelope)
   return new Promise((resolve,reject)=>{pending.set(packet.id,{...packet,acked:new Set(),resolve,reject});for(const link of links.values())flush(link)})
  },
  sync(){for(const link of links.values())if(link.ready)sendFrame(link,['REQ','inbox',{kinds:[1059],'#p':[owner]}])},
  close(){stopped=true;for(const timer of retries)clearTimeout(timer);for(const link of links.values()){clearTimeout(link.timer);link.socket.onclose=null;link.socket.onerror=null;link.socket.close()}for(const task of pending.values())task.reject(Error('中继连接已关闭'));pending.clear();key.fill(0)},
 }
}
