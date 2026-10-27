import {it} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,existsSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools/pure'
import {createGateway} from '../server.js'
import {MemberStore} from '../members.js'
import {coreSeedAllowed} from '../invite.js'
const teacher=generateSecretKey(),student=generateSecretKey(),outsider=generateSecretKey(),founder=generateSecretKey(),nextTeacher=generateSecretKey()
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)))
const close=s=>new Promise(r=>{s.closeAllConnections?.();s.close(r)})
function invite(key,url,expires=Math.floor(Date.now()/1000)+604800){return finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url+'/invite/redeem'],['method','POST'],['expiration',String(expires)],['nonce',crypto.randomUUID()]],content:'{"type":"aster.invite","version":1}'},key)}
function recommendation(key,url,reason='synthetic reason',expires=Math.floor(Date.now()/1000)+604800){return finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url+'/invite/teacher'],['method','POST'],['expiration',String(expires)],['nonce',crypto.randomUUID()],['reason',reason]],content:'{"type":"aster.teacher-recommendation","version":1}'},key)}
function promotion(key,url,expires=Math.floor(Date.now()/1000)+604800){return finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',url+'/invite/core-add'],['method','POST'],['expiration',String(expires)],['nonce',crypto.randomUUID()]],content:'{"type":"aster.core-promotion","version":1}'},key)}
async function post(base,path,key,body){const text=JSON.stringify(body),event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),tags:[['u',base+path],['method','POST'],['payload',createHash('sha256').update(text).digest('hex')],['nonce',crypto.randomUUID()]],content:''},key);return fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')},body:text})}
async function fixture(run,seed=false,withSetup=false){const dir=mkdtempSync(join(tmpdir(),'aster-invite-')),file=join(dir,'members.json'),logFile=join(dir,'gateway.log'),seedTokenFile=join(dir,'seed.json'),coreSeedTokenFile=join(dir,'core-seed.json'),setupDir=join(dir,'setup'),recommendationsFile=join(dir,'recommendations.json');writeFileSync(file,JSON.stringify(seed?{members:[],teachers:[],coreMembers:[]}:{members:[getPublicKey(teacher),getPublicKey(nextTeacher)],teachers:[getPublicKey(teacher),getPublicKey(nextTeacher)],coreMembers:[getPublicKey(teacher)]}));writeFileSync(seedTokenFile,JSON.stringify({tokenHash:createHash('sha256').update('SYNTHETIC_DEPLOYMENT_TOKEN').digest('hex')}));writeFileSync(coreSeedTokenFile,JSON.stringify({tokenHash:createHash('sha256').update('SYNTHETIC_CORE_TOKEN').digest('hex')}));writeFileSync(recommendationsFile,'[]');if(withSetup){mkdirSync(setupDir);writeFileSync(join(setupDir,'teacher-setup-code.txt'),'SYNTHETIC_DEPLOYMENT_TOKEN');writeFileSync(join(setupDir,'teacher-setup.html'),'<html>synthetic setup</html>');writeFileSync(join(setupDir,'core-member-code.txt'),'SYNTHETIC_CORE_TOKEN');writeFileSync(join(setupDir,'core-member.html'),'<html>synthetic core setup</html>');writeFileSync(join(setupDir,'keep.txt'),'keep')}const upstream=createServer((req,res)=>res.end('{"choices":[]}')),up=await listen(upstream);const gateway=createGateway({membersFile:file,seedTokenFile,coreSeedTokenFile,recommendationsFile,setupDir,logFile,upstreamBaseUrl:up,upstreamModel:'synthetic',upstreamApiKeyEnv:'UNUSED',rateLimit:{windowMs:60000,maxPerWindow:100}}),url=await listen(gateway);try{await run({url,file,logFile,seedTokenFile,coreSeedTokenFile,recommendationsFile,setupDir})}finally{await close(gateway);await close(upstream);rmSync(dir,{recursive:true,force:true})}}
it('redeem adds member atomically and authorizes model immediately without restarting; reusable for another student',()=>fixture(async({url,file,logFile})=>{
 assert.equal((await post(url,'/v1/chat/completions',student,{messages:[]})).status,403)
 const ticket=invite(teacher,url)
 for(const key of [student,outsider]){assert.equal((await post(url,'/invite/redeem',key,{invite:ticket})).status,200);assert.equal((await post(url,'/v1/chat/completions',key,{messages:[]})).status,200)}
 assert.equal(JSON.parse(readFileSync(file,'utf8')).members.length,4)
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
 assert.deepEqual(JSON.parse(readFileSync(file)),{members:[getPublicKey(teacher)],teachers:[getPublicKey(teacher)],coreMembers:[]})
 assert.ok(!readFileSync(logFile,'utf8').includes('SYNTHETIC_DEPLOYMENT_TOKEN'))
},true))
it('failed atomic rename keeps original member file and no speculative membership',()=>{const dir=mkdtempSync(join(tmpdir(),'aster-members-')),file=join(dir,'members.json');writeFileSync(file,JSON.stringify([getPublicKey(teacher)]));try{const store=new MemberStore(file,()=>{throw Error('synthetic crash')});assert.throws(()=>store.add(getPublicKey(student)));assert.equal(store.has(getPublicKey(student)),false);assert.deepEqual(JSON.parse(readFileSync(file)),[getPublicKey(teacher)])}finally{rmSync(dir,{recursive:true,force:true})}})
// V2-31：首次登记成功后删掉本机的口令与 teacher-setup.html；只删这两个已知文件，不动同目录其它文件。
it('V2-31 首次登记成功后删除本机口令与 teacher-setup.html，日志仍不含口令',()=>fixture(async({url,seedTokenFile,logFile,setupDir})=>{
 assert.equal(existsSync(join(setupDir,'teacher-setup-code.txt')),true)
 assert.equal((await post(url,'/invite/seed',teacher,{token:'SYNTHETIC_DEPLOYMENT_TOKEN'})).status,200)
 assert.equal(existsSync(join(setupDir,'teacher-setup-code.txt')),false)
 assert.equal(existsSync(join(setupDir,'teacher-setup.html')),false)
 assert.equal(existsSync(join(setupDir,'keep.txt')),true)
 const seed=JSON.parse(readFileSync(seedTokenFile,'utf8'))
 assert.equal(seed.tokenHash,createHash('sha256').update('SYNTHETIC_DEPLOYMENT_TOKEN').digest('hex'))
 assert.equal(seed.usedFor,getPublicKey(teacher))
 assert.ok(!readFileSync(logFile,'utf8').includes('SYNTHETIC_DEPLOYMENT_TOKEN'))
},true,true))

it('V2-37 只有老师签出的学生邀请可兑换，学生自己签的邀请被拒绝',()=>fixture(async({url,file})=>{
 const studentSigned=invite(student,url)
 const teacherSigned=invite(teacher,url)
 assert.equal((await post(url,'/invite/redeem',outsider,{invite:studentSigned})).status,403)
 assert.equal((await post(url,'/invite/redeem',student,{invite:teacherSigned})).status,200)
 const state=JSON.parse(readFileSync(file,'utf8'))
 assert.ok(state.members.includes(getPublicKey(student)))
 assert.ok(!state.teachers.includes(getPublicKey(student)))
}))

it('V2-37b 核心登记不授予老师身份，核心成员可推荐老师但不能签学生邀请',()=>fixture(async({url,file,coreSeedTokenFile,logFile,setupDir})=>{
 assert.equal((await post(url,'/invite/seed',teacher,{token:'SYNTHETIC_DEPLOYMENT_TOKEN'})).status,200)
 assert.equal((await post(url,'/invite/redeem',founder,{invite:invite(teacher,url)})).status,200)
 assert.deepEqual(await (await post(url,'/invite/core-status',founder,{})).json(),{teacher:false,core:false})
 assert.equal((await post(url,'/invite/core-seed',founder,{token:'wrong'})).status,403)
 assert.equal((await post(url,'/invite/core-seed',founder,{token:'SYNTHETIC_CORE_TOKEN'})).status,200)
 assert.equal((await post(url,'/invite/core-seed',founder,{token:'SYNTHETIC_CORE_TOKEN'})).status,403)
 assert.equal((await post(url,'/invite/core-seed',student,{token:'SYNTHETIC_CORE_TOKEN'})).status,403)
 assert.equal((await post(url,'/invite/seed',nextTeacher,{token:'SYNTHETIC_DEPLOYMENT_TOKEN'})).status,403)
 const state=JSON.parse(readFileSync(file,'utf8'))
 assert.ok(state.members.includes(getPublicKey(founder)))
 assert.ok(!state.teachers.includes(getPublicKey(founder)))
 assert.ok(state.teachers.includes(getPublicKey(teacher)))
 assert.ok(state.coreMembers.includes(getPublicKey(founder)))
 assert.deepEqual(await (await post(url,'/invite/core-status',founder,{})).json(),{teacher:false,core:true})
 assert.equal((await post(url,'/invite/redeem',student,{invite:invite(founder,url)})).status,403)
 assert.equal((await post(url,'/invite/teacher',nextTeacher,{recommendation:recommendation(founder,url)})).status,200)
 assert.equal((await post(url,'/invite/core-add',nextTeacher,{promotion:promotion(founder,url)})).status,200)
 assert.equal(JSON.parse(readFileSync(coreSeedTokenFile,'utf8')).usedFor,getPublicKey(founder))
 assert.equal(existsSync(join(setupDir,'core-member-code.txt')),false)
 assert.equal(existsSync(join(setupDir,'core-member.html')),false)
 assert.ok(existsSync(join(setupDir,'keep.txt')))
 assert.ok(!readFileSync(logFile,'utf8').includes('SYNTHETIC_CORE_TOKEN'))
},true,true))

it('V2-37b 已登记老师成为核心成员后仍是老师',()=>fixture(async({url,file})=>{
 assert.equal((await post(url,'/invite/seed',teacher,{token:'SYNTHETIC_DEPLOYMENT_TOKEN'})).status,200)
 assert.equal((await post(url,'/invite/core-seed',teacher,{token:'SYNTHETIC_CORE_TOKEN'})).status,200)
 const state=JSON.parse(readFileSync(file,'utf8'))
 assert.ok(state.teachers.includes(getPublicKey(teacher)))
 assert.ok(state.coreMembers.includes(getPublicKey(teacher)))
 assert.equal((await post(url,'/invite/redeem',student,{invite:invite(teacher,url)})).status,200)
},true))

it('V2-37b 核心登记认领后若名单写入中断，只允许同一身份重试',()=>fixture(async({coreSeedTokenFile})=>{
 const record=JSON.parse(readFileSync(coreSeedTokenFile,'utf8'))
 record.usedFor=getPublicKey(founder)
 writeFileSync(coreSeedTokenFile,JSON.stringify(record))
 const members={hasCoreMembers:()=>false}
 assert.equal(coreSeedAllowed({coreSeedTokenFile},members,'SYNTHETIC_CORE_TOKEN',getPublicKey(student)),false)
 assert.equal(coreSeedAllowed({coreSeedTokenFile},members,'SYNTHETIC_CORE_TOKEN',getPublicKey(founder)),true)
},true))

it('V2-37 核心成员推荐绑定首次扫码身份、记本机记录且不能复用',()=>fixture(async({url,file,recommendationsFile,logFile})=>{
 const ticket=recommendation(teacher,url,'synthetic recommendation reason')
 const body={recommendation:ticket}
 assert.equal((await post(url,'/invite/teacher',outsider,body)).status,200)
 assert.equal((await post(url,'/invite/teacher',outsider,body)).status,403)
 assert.equal((await post(url,'/invite/teacher',nextTeacher,body)).status,403)
 const state=JSON.parse(readFileSync(file,'utf8'))
 assert.ok(state.members.includes(getPublicKey(outsider)))
 assert.ok(state.teachers.includes(getPublicKey(outsider)))
 const [record]=JSON.parse(readFileSync(recommendationsFile,'utf8'))
 assert.equal(record.eventId,ticket.id)
 assert.equal(record.recommender,getPublicKey(teacher))
 assert.equal(record.teacher,getPublicKey(outsider))
 assert.equal(record.reason,'synthetic recommendation reason')
 assert.ok(Number.isSafeInteger(record.usedAt))
 const log=readFileSync(logFile,'utf8')
 assert.ok(!log.includes('synthetic recommendation reason'))
 assert.ok(!log.includes(ticket.sig))
}))

it('V2-37 推荐链接过期、非核心签名、签名篡改和错误部署均拒绝',()=>fixture(async({url})=>{
 const good=recommendation(teacher,url)
 const bad=[
  recommendation(teacher,url,'synthetic',Math.floor(Date.now()/1000)-1),
  recommendation(nextTeacher,url),
  {...good,sig:'0'.repeat(128)},
  recommendation(teacher,'https://wrong.example'),
 ]
 for(const ticket of bad)assert.equal((await post(url,'/invite/teacher',outsider,{recommendation:ticket})).status,403)
}))

it('V2-37 核心状态只能由已登记身份查询，核心成员可签发单次老师晋升链接',()=>fixture(async({url,file,recommendationsFile})=>{
 const status=await post(url,'/invite/core-status',teacher,{})
 assert.equal(status.status,200)
 assert.deepEqual(await status.json(),{teacher:true,core:true})
 assert.equal((await post(url,'/invite/core-status',student,{})).status,403)
 const ticket=promotion(teacher,url)
 assert.equal((await post(url,'/invite/core-add',outsider,{promotion:ticket})).status,403)
 assert.equal((await post(url,'/invite/core-add',nextTeacher,{promotion:ticket})).status,200)
 assert.equal((await post(url,'/invite/core-add',nextTeacher,{promotion:ticket})).status,403)
 assert.ok(JSON.parse(readFileSync(file,'utf8')).coreMembers.includes(getPublicKey(nextTeacher)))
 const record=JSON.parse(readFileSync(recommendationsFile,'utf8')).find(item=>item.eventId===ticket.id)
 assert.equal(record.kind,'promotion')
 assert.equal(record.teacher,getPublicKey(nextTeacher))
}))

it('V2-37 通过传统部署口令登记的老师是老师但不是核心成员',()=>fixture(async({url,file})=>{
 assert.equal((await post(url,'/invite/seed',teacher,{token:'SYNTHETIC_DEPLOYMENT_TOKEN'})).status,200)
 const state=JSON.parse(readFileSync(file,'utf8'))
 assert.ok(state.teachers.includes(getPublicKey(teacher)))
 assert.ok(!state.coreMembers.includes(getPublicKey(teacher)))
},true))

it('V2-37 旧平表不迁移；只从 seed.usedFor 识别历史老师，学生签发仍拒绝',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aster-legacy-members-')),file=join(dir,'members.json'),seedTokenFile=join(dir,'seed.json'),coreSeedTokenFile=join(dir,'core-seed.json'),recommendationsFile=join(dir,'recommendations.json'),logFile=join(dir,'gateway.log')
 writeFileSync(file,JSON.stringify([getPublicKey(teacher),getPublicKey(student)]));writeFileSync(seedTokenFile,JSON.stringify({tokenHash:'0'.repeat(64),usedFor:getPublicKey(teacher)}));writeFileSync(coreSeedTokenFile,JSON.stringify({tokenHash:'1'.repeat(64)}));writeFileSync(recommendationsFile,'[]')
 const upstream=createServer((req,res)=>res.end('{"choices":[]}')),up=await listen(upstream),gateway=createGateway({membersFile:file,seedTokenFile,coreSeedTokenFile,recommendationsFile,logFile,upstreamBaseUrl:up,upstreamModel:'synthetic',upstreamApiKeyEnv:'UNUSED',rateLimit:{windowMs:60000,maxPerWindow:100}}),url=await listen(gateway)
 try{
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),[getPublicKey(teacher),getPublicKey(student)])
  assert.equal((await post(url,'/invite/redeem',outsider,{invite:invite(teacher,url)})).status,200)
  assert.equal((await post(url,'/invite/redeem',outsider,{invite:invite(student,url)})).status,403)
  const next=JSON.parse(readFileSync(file,'utf8'))
  assert.ok(next.teachers.includes(getPublicKey(teacher)))
  assert.ok(!next.teachers.includes(getPublicKey(student)))
 }finally{await close(gateway);await close(upstream);rmSync(dir,{recursive:true,force:true})}
})
