import { finalizeEvent, type Event } from 'nostr-tools/pure'
import type { Identity } from '../identity'
import { BACKUP_KIND, BACKUP_SLOTS, type BackupRelay } from './index'
// 独立NIP-01/42适配器：M1-06分支可从main编译，不复制未合并M1-05源码。
export function communityBackupRelay(identity:Identity,inputs:string[],socketFactory:(url:string)=>WebSocket=url=>new WebSocket(url)):BackupRelay&{close():void} {
 const key=new Uint8Array(identity.privateKey),owner=identity.publicKey,sockets=new Set<WebSocket>()
 let closed=false
 const urls=[...new Set(inputs.map(input=>{const url=new URL(input);if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('备份中继需要WSS');return url.href}))]
 function operation(url:string,event?:Event):Promise<Event[]> {
  if(closed)return Promise.reject(Error('备份连接已关闭'))
  return new Promise((resolve,reject)=>{
   let socket:WebSocket
   try{socket=socketFactory(url)}catch{reject(Error('备份中继不可达'));return}
   sockets.add(socket)
   let done=false,authId='',ready=false
   const events:Event[]=[]
   const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);sockets.delete(socket);socket.onclose=null;socket.onerror=null;socket.close();if(error)reject(error);else resolve(events)}
   const timer=setTimeout(()=>finish(Error('备份中继超时')),10000)
   socket.onerror=()=>finish(Error('备份中继不可达'));socket.onclose=()=>finish(Error('备份中继断开'))
   socket.onmessage=({data})=>{
    if(done||typeof data!=='string'||new TextEncoder().encode(data).length>2*1024*1024+1024)return
    try{
     const frame=JSON.parse(data)
     if(frame[0]==='AUTH'&&typeof frame[1]==='string'){
      const auth=finalizeEvent({kind:22242,created_at:Math.floor(Date.now()/1000),tags:[['relay',url],['challenge',frame[1]]],content:''},key)
      authId=auth.id;socket.send(JSON.stringify(['AUTH',auth]))
     }else if(frame[0]==='OK'&&frame[1]===authId){
      if(frame[2]!==true){finish(Error('备份中继鉴权失败'));return}
      ready=true
      socket.send(JSON.stringify(event?['EVENT',event]:['REQ','backup',{kinds:[BACKUP_KIND],authors:[owner],'#d':BACKUP_SLOTS,limit:3}]))
     }else if(ready&&event&&frame[0]==='OK'&&frame[1]===event.id){finish(frame[2]===true?undefined:Error('备份中继拒绝写入'))}
     else if(ready&&!event&&frame[0]==='EVENT'&&frame[1]==='backup'){if(events.length>=16){finish(Error('备份中继回复过多'));return}events.push(frame[2])}
     else if(ready&&!event&&frame[0]==='EOSE'&&frame[1]==='backup')finish()
     else if(frame[0]==='CLOSED')finish(Error('备份中继拒绝读取'))
    }catch{finish(Error('备份中继回复无效'))}
   }
  })
 }
 const configured=()=>{if(!urls.length)throw Error('社区备份中继未配置')}
 return {
  async list(pubkey){configured();if(pubkey!==owner)throw Error('只能读取本人备份');const lists=await Promise.all(urls.map(url=>operation(url)));return [...new Map(lists.flat().map(event=>[event.id,event])).values()]},
  async publish(event){configured();if(event.pubkey!==owner)throw Error('只能发布本人备份');await Promise.all(urls.map(url=>operation(url,event)))},
  close(){closed=true;for(const socket of sockets)socket.close();sockets.clear();key.fill(0)},
 }
}
