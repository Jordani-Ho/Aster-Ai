import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {createHash,randomUUID} from 'node:crypto'
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools/pure'
import {createGateway} from '../server.js'
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)))
const close=s=>new Promise(r=>{s.close(r);s.closeAllConnections()})
async function setup(options={}){
 const dir=mkdtempSync(join(tmpdir(),'aster-proxy-')),key=generateSecretKey(),membersFile=join(dir,'members.json'),logFile=join(dir,'log');writeFileSync(membersFile,JSON.stringify([getPublicKey(key)]))
 const calls=[];const up=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;calls.push({url:req.url,auth:req.headers.authorization,text});if(text.includes('REDIRECT')){res.writeHead(307,{location:'http://127.0.0.1:1/stolen'}).end();return}if(text.includes('HANG'))return;res.writeHead(200,{'content-type':'text/event-stream'}).end('data: SYNTHETIC_REPLY\n\n')})
 const upstream=await listen(up),target=upstream+'/v1/chat/completions'
 const server=createGateway({membersFile,logFile,upstreamBaseUrl:upstream,upstreamModel:'house',rateLimit:{windowMs:60000,maxPerWindow:30},proxyAllowedUrls:[target],upstreamTimeoutMs:60,...options}),base=await listen(server)
 const post=async(payload,{path='/v1/proxy',signer=key,bodyOverride,headerOverride}={})=>{const body=JSON.stringify(payload),url=base+path;const event=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',url],['method','POST'],['payload',createHash('sha256').update(body).digest('hex')],['nonce',randomUUID()]]},signer);return fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:headerOverride??'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64')},body:bodyOverride??body})}
 return {dir,calls,target,post,log:()=>readFileSync(logFile,'utf8'),close:async()=>{await close(server);await close(up);rmSync(dir,{recursive:true,force:true})}}
}
test('proxy preserves own request/model/token/stream; metrics never log secret, url or contents',async()=>{const f=await setup();try{const body=JSON.stringify({model:'SYNTHETIC_USER_MODEL',stream:true,messages:[{role:'user',content:'SYNTHETIC_PRIVATE'}]});const r=await f.post({url:f.target,apiKey:'SYNTHETIC_SECRET',body});assert.equal(r.status,200);assert.match(await r.text(),/SYNTHETIC_REPLY/);assert.deepEqual(f.calls,[{url:'/v1/chat/completions',auth:'Bearer SYNTHETIC_SECRET',text:body}]);assert.doesNotMatch(f.log(),/SYNTHETIC|127\.0\.0\.1|Bearer|messages/)}finally{await f.close()}})
test('proxy retains membership, payload binding and rate/body limits; house fallback has explicit off switch',async()=>{const f=await setup({fallbackEnabled:false,maxBodyBytes:600});try{const payload={url:f.target,apiKey:'SYNTHETIC_SECRET',body:'{}'};assert.equal((await f.post(payload,{signer:generateSecretKey()})).status,403);assert.equal((await f.post(payload,{bodyOverride:'{}'})).status,401);assert.equal((await f.post({...payload,body:'x'.repeat(700)})).status,413);assert.equal((await f.post({messages:[]},{path:'/v1/chat/completions'})).status,503);assert.equal(f.calls.length,0)}finally{await f.close()}})
test('proxy rejects arbitrary destinations, userinfo and redirects; timeout does not leak error text',async()=>{const f=await setup();try{for(const url of ['http://169.254.169.254/latest','https://attacker.example/v1/chat/completions',f.target+'?key=foo',f.target.replace('http://','http://name:pass@')])assert.equal((await f.post({url,apiKey:'SYNTHETIC_SECRET',body:'{}'})).status,400);assert.equal((await f.post({url:f.target,apiKey:'SYNTHETIC_SECRET',body:'{"note":"REDIRECT"}'})).status,502);assert.equal((await f.post({url:f.target,apiKey:'SYNTHETIC_SECRET',body:'{"note":"HANG"}'})).status,504);assert.doesNotMatch(f.log(),/SYNTHETIC|HANG|REDIRECT/)}finally{await f.close()}})
