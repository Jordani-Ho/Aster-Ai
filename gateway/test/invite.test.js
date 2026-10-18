import {it} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools/pure'
import {createGateway} from '../server.js'
import {MemberStore} from '../members.js'
const teacher=generateSecretKey(),student=generateSecretKey(),outsider=generateSecretKey()
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)))
const close=s=>new Promise(r=>{s.closeAllConnections?.();s.close(r)})
function invite(key,url,expires=Math.floor(Date.now()/1000)+604800){return finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url+'/invite/redeem'],['method','POST'],['expiration',String(expires)],['nonce',crypto.randomUUID()]],content:'{"type":"aster.invite","version":1}'},key)}
async function post(base,path,key,body){const text=JSON.stringify(body),event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',base+path],['method','POST'],['payload',createHash('sha256').update(text).digest('hex')],['nonce',crypto.randomUUID()]],content:''},key);return fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')},body:text})}
async function fixture(run,seed=false){const dir=mkdtempSync(join(tmpdir(),'aster-invite-')),file=join(dir,'members.json'),logFile=join(dir,'gateway.log'),seedTokenFile=join(dir,'seed.json');writeFileSync(file,JSON.stringify(seed?[]:[getPublicKey(teacher)]));writeFileSync(seedTokenFile,JSON.stringify({tokenHash:createHash('sha256').update('SYNTHETIC_DEPLOYMENT_TOKEN').digest('hex')}));const upstream=createServer((req,res)=>res.end('{"choices":[]}')),up=await listen(upstream);const gateway=createGateway({membersFile:file,seedTokenFile,logFile,upstreamBaseUrl:up,upstreamModel:'synthetic',upstreamApiKeyEnv:'UNUSED',rateLimit:{windowMs:60000,maxPerWindow:100}}),url=await listen(gateway);try{await run({url,file,logFile,seedTokenFile})}finally{await close(gateway);await close(upstream);rmSync(dir,{recursive:true,force:true})}}
it('redeem adds member atomically and authorizes model immediately without restarting; reusable for another student',()=>fixture(async({url,file,logFile})=>{
 assert.equal((await post(url,'/v1/chat/completions',student,{messages:[]})).status,403)
 const ticket=invite(teacher,url)
 for(const key of [student,outsider]){assert.equal((await post(url,'/invite/redeem',key,{invite:ticket})).status,200);assert.equal((await post(url,'/v1/chat/completions',key,{messages:[]})).status,200)}
 assert.equal(JSON.parse(readFileSync(file)).length,3)
 const log=readFileSync(logFile,'utf8');assert.ok(!log.includes(ticket.sig));assert.ok(!log.includes(getPublicKey(student)))
}))
it('expired, nonmember, tampered, duplicate-tag and wrong-gateway invitations are rejected',()=>fixture(async({url})=>{
 const good=JSON.parse(JSON.stringify(invite(teacher,url)))
 const bad=[invite(teacher,url,Math.floor(Date.now()/1000)-1),invite(outsider,url),{...good,sig:'0'.repeat(128)},invite(teacher,'https://wrong.example'),{...good,tags:[...good.tags,['expiration','9999999999']]}]
 for(const ticket of bad)assert.equal((await post(url,'/invite/redeem',student,{invite:ticket})).status,403)
 assert.equal((await post(url,'/v1/chat/completions',student,{messages:[]})).status,403)
}))
it('member file edits become effective without restart',()=>fixture(async({url,file})=>{writeFileSync(file,JSON.stringify([getPublicKey(teacher),getPublicKey(student)]));assert.equal((await post(url,'/v1/chat/completions',student,{messages:[]})).status,200)}))
it('deployment token claims exactly one seed identity and permits same-identity retry',()=>fixture(async({url,file,logFile})=>{
 assert.equal((await post(url,'/invite/seed',teacher,{token:'wrong'})).status,403)
 assert.equal((await post(url,'/invite/seed',teacher,{token:'SYNTHETIC_DEPLOYMENT_TOKEN'})).status,200)
 assert.equal((await post(url,'/invite/seed',teacher,{token:'SYNTHETIC_DEPLOYMENT_TOKEN'})).status,200)
 assert.equal((await post(url,'/invite/seed',student,{token:'SYNTHETIC_DEPLOYMENT_TOKEN'})).status,403)
 assert.deepEqual(JSON.parse(readFileSync(file)),[getPublicKey(teacher)])
 assert.ok(!readFileSync(logFile,'utf8').includes('SYNTHETIC_DEPLOYMENT_TOKEN'))
},true))
it('failed atomic rename keeps original member file and no speculative membership',()=>{const dir=mkdtempSync(join(tmpdir(),'aster-members-')),file=join(dir,'members.json');writeFileSync(file,JSON.stringify([getPublicKey(teacher)]));try{const store=new MemberStore(file,()=>{throw Error('synthetic crash')});assert.throws(()=>store.add(getPublicKey(student)));assert.equal(store.has(getPublicKey(student)),false);assert.deepEqual(JSON.parse(readFileSync(file)),[getPublicKey(teacher)])}finally{rmSync(dir,{recursive:true,force:true})}})
