import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPushService, SubscriptionStore, PUSH_TEXT } from '../push/index.js'
const owner = 'a'.repeat(64), caller = 'b'.repeat(64)
const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic', keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } }
const file = () => join(mkdtempSync(join(tmpdir(), 'aster-push-')), 'push-subscriptions.json')
it('订阅持久化、只发固定文案、注销后不发、5次限流与调用方隔离', async () => {
 const path = file(), sent = []
 const make = () => createPushService({ file: path, send: async (sub, text) => sent.push({ sub, text }) })
 let service = make()
 await service.handle('/push/subscribe', owner, { subscription, pubkey: caller })
 service = make()
 for (let i=0;i<5;i++) assert.equal((await service.handle('/push/notify', caller, { pubkey: owner, text: 'SYNTHETIC_SECRET' })).status, 202)
 assert.equal((await service.handle('/push/notify', caller, { pubkey: owner })).status, 429)
 assert.equal(sent.length,5)
 assert.ok(sent.every(item=>item.text===PUSH_TEXT && !item.text.includes('SYNTHETIC_SECRET')))
 assert.equal((await service.handle('/push/notify', owner, { pubkey: owner })).status,202)
 await service.handle('/push/unsubscribe', owner, {})
 assert.equal(JSON.parse(readFileSync(path,'utf8'))[owner],undefined)
 await service.handle('/push/notify', 'c'.repeat(64), { pubkey: owner })
 assert.equal(sent.length,6)
})
it('崩溃在改名前，原文件及内存保持完好，重启恢复', () => {
 const path = file(), store = new SubscriptionStore(path)
 store.set(owner,subscription)
 const old = readFileSync(path,'utf8')
 const broken = new SubscriptionStore(path, () => { throw new Error('synthetic crash before rename') })
 assert.throws(()=>broken.set(caller,subscription))
 assert.equal(readFileSync(path,'utf8'),old)
 assert.equal(broken.get(caller),undefined)
 assert.deepEqual(new SubscriptionStore(path).get(owner),subscription)
})
it('拒绝任意 URL/本地端点，不保存额外字段，410 删除过期订阅', async () => {
 const path=file()
 const service=createPushService({file:path,send:async()=>{throw {statusCode:410}}})
 for (const endpoint of ['http://127.0.0.1/push','https://localhost/push','https://attacker.example/push','https://fcm.googleapis.com@127.0.0.1/push']) {
 assert.equal((await service.handle('/push/subscribe',owner,{subscription:{...subscription,endpoint}})).status,400)
 }
 assert.equal((await service.handle('/push/subscribe',owner,{subscription:{...subscription,privateText:'SYNTHETIC_SECRET'}})).status,200)
 assert.ok(!readFileSync(path,'utf8').includes('SYNTHETIC_SECRET'))
 await service.handle('/push/notify',caller,{pubkey:owner})
 assert.equal(JSON.parse(readFileSync(path,'utf8'))[owner],undefined)
})
import { createGateway } from '../server.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
it('真实 HTTP：推送路由沿用成员鉴权、防重放、体积上限、全局限流与404', async () => {
 const path=file(), dir=join(path,'..'), membersFile=join(dir,'members.json')
 const key=generateSecretKey(), pubkey=getPublicKey(key)
 writeFileSync(membersFile,JSON.stringify([pubkey]))
 const sent=[]
 const server=createGateway({membersFile,logFile:join(dir,'test.log'),maxBodyBytes:1024,rateLimit:{windowMs:60000,maxPerWindow:20},push:{subscriptionsFile:path,send:async(...args)=>sent.push(args)}})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base='http://127.0.0.1:'+server.address().port
 async function request(route, value, signingKey=key, header) {
 const body=JSON.stringify(value),url=base+route
 const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url],['method','POST'],['payload',createHash('sha256').update(body).digest('hex')],['nonce',randomUUID()]],content:''},signingKey??key)
 const authorization=header??'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')
 return {response:await fetch(url,{method:'POST',headers:signingKey?{authorization}:{},body}),authorization}
 }
 try {
 for(const route of ['/push/subscribe','/push/unsubscribe','/push/notify']) {
 assert.equal((await request(route,{},null)).response.status,401)
 assert.equal((await request(route,{},generateSecretKey())).response.status,403)
 assert.equal((await request(route,{data:'x'.repeat(2000)})).response.status,413)
 }
 assert.equal((await request('/push/subscribe',{subscription})).response.status,200)
 const value={pubkey,text:'SYNTHETIC_PRIVATE_TEXT'}
 const result=await request('/push/notify',value)
 assert.equal(result.response.status,202)
 assert.equal((await request('/push/notify',value,key,result.authorization)).response.status,401)
 assert.equal(sent[0][1],PUSH_TEXT)
 assert.equal((await request('/push/unsubscribe',{})).response.status,200)
 assert.equal((await request('/v1/files',{})).response.status,404)
 assert.equal((await request('/push/anything',{})).response.status,404)
 } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
})
it('每分钟限流到期后可再次提醒',async()=>{
 let now=0
 const service=createPushService({file:file(),send:async()=>{},now:()=>now})
 for(let i=0;i<5;i++) assert.equal((await service.handle('/push/notify',caller,{pubkey:owner})).status,202)
 assert.equal((await service.handle('/push/notify',caller,{pubkey:owner})).status,429)
 now=60000
 assert.equal((await service.handle('/push/notify',caller,{pubkey:owner})).status,202)
})

it('NIP-98：同内容请求带不同 nonce 都通过，原样重放仍然 401', async () => {
 const path=file(), dir=join(path,'..'), membersFile=join(dir,'members.json')
 const key=generateSecretKey(), pubkey=getPublicKey(key)
 writeFileSync(membersFile, JSON.stringify([pubkey]))
 const server=createGateway({ membersFile, logFile: join(dir,'nonce.log'), maxBodyBytes: 1024, rateLimit: { windowMs: 60000, maxPerWindow: 20 }, push: { subscriptionsFile: path, send: async () => {} } })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base='http://127.0.0.1:'+server.address().port
 const body=JSON.stringify({ subscription })
 const headerWithNonce = nonce => {
  const url=base+'/push/subscribe'
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url],['method','POST'],['payload',createHash('sha256').update(body).digest('hex')],['nonce',nonce]],content:''},key)
  return 'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')
 }
 const send = authorization => fetch(base+'/push/subscribe',{method:'POST',headers:{authorization},body})
 try {
  const first = headerWithNonce(randomUUID())
  const second = headerWithNonce(randomUUID())
  assert.equal((await send(first)).status, 200)
  assert.equal((await send(second)).status, 200)
  assert.equal((await send(first)).status, 401)
 } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
})

it('投递失败也返回 202，网关日志只记状态 502', async () => {
 const path=file(), dir=join(path,'..'), membersFile=join(dir,'members.json'), logFile=join(dir,'push-fail.log')
 const key=generateSecretKey(), pubkey=getPublicKey(key)
 writeFileSync(membersFile, JSON.stringify([pubkey]))
 const failingSend = async () => { const error = new Error('synthetic delivery failure'); error.statusCode = 500; throw error }
 const server=createGateway({ membersFile, logFile, maxBodyBytes:1024, rateLimit:{windowMs:60000,maxPerWindow:20}, push:{subscriptionsFile:path,send:failingSend} })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base='http://127.0.0.1:'+server.address().port
 const post = async (route, value) => {
  const body=JSON.stringify(value), url=base+route
  const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url],['method','POST'],['payload',createHash('sha256').update(body).digest('hex')],['nonce',randomUUID()]],content:''},key)
  return fetch(url,{method:'POST',headers:{authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64'),'content-type':'application/json'},body})
 }
 try {
  assert.equal((await post('/push/subscribe',{subscription})).status,200)
  assert.equal((await post('/push/notify',{pubkey})).status,202)
  const raw=readFileSync(logFile,'utf8')
  const lines=raw.trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(lines[lines.length-1].status,502)
  assert.deepEqual(Object.keys(lines[lines.length-1]).sort(),['durationMs','pubkey','status','time'])
  assert.ok(!raw.includes(subscription.endpoint))
 } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
})
