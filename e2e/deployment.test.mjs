import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm,readdir} from 'node:fs/promises'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {root} from './process.mjs'
const linux=p=>p.replace(/^([A-Z]):/i,(_,letter)=>'/mnt/'+letter.toLowerCase()).replaceAll('\\','/')
async function workspace(){await mkdir(path.join(root,'.cache/e2e'),{recursive:true});const dir=await mkdtemp(path.join(root,'.cache/e2e/setup-'));for(const file of ['deploy/home/setup.sh','deploy/home/scripts/generate-gateway.mjs','gateway/members.js','relay/configure.mjs','package.json']){await mkdir(path.dirname(path.join(dir,file)),{recursive:true});await copyFile(path.join(root,file),path.join(dir,file))}return dir}
function bash(script,env){const result=process.platform==='win32'?spawnSync('wsl.exe',['-d','Ubuntu','--exec','env',...Object.entries(env).map(([k,v])=>k+'='+v),'bash',linux(script)],{encoding:'utf8'}):spawnSync('bash',[script],{encoding:'utf8',env:{...process.env,...env}});assert.equal(result.status,0,result.stderr);return result.stdout}
test('第二版 setup 不写成员白名单：开放模式起中继、生成一次性口令、重跑保留成员与口令；不用真实 Docker',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=path.join(dir,'fake-bin')
 try{
  await mkdir(bin);await writeFile(path.join(bin,'docker'),'#!/bin/sh\nexit 0\n',{mode:0o755})
  if(process.platform==='win32'){const result=spawnSync('wsl.exe',['-d','Ubuntu','--exec','chmod','+x',linux(path.join(bin,'docker'))]);assert.equal(result.status,0)}
  await writeFile(path.join(home,'.env'),'APP_DOMAIN=app.example\nRELAY_DOMAIN=relay.example\nVAPID_SUBJECT=mailto:synthetic@example.invalid\nVAPID_PUBLIC_KEY=synthetic\nVAPID_PRIVATE_KEY=synthetic\nMODEL_FALLBACK_ENABLED=false\nMODEL_PROXY_ALLOWED_URLS=https://synthetic.example/v1/chat/completions\nRELAY_COMMUNITY_OPEN=true\n')
  const env={SKIP_BUILD:'1',PATH:process.platform==='win32'?linux(bin)+':/usr/local/bin:/usr/bin:/bin':bin+':'+process.env.PATH},script=path.join(home,'setup.sh'),out=bash(script,env)
  const token=await readFile(path.join(home,'data/teacher-setup-code.txt'),'utf8'),seed=await readFile(path.join(home,'data/gateway/seed.json'),'utf8')
  assert.ok(token.trim().length>=40);assert.ok(!seed.includes(token.trim()));assert.ok(!out.includes(token.trim()))
  const cfg=JSON.parse(await readFile(path.join(home,'data/gateway-config.json'),'utf8'));assert.equal(cfg.membersFile,'/app/data/members.json');assert.equal(cfg.seedTokenFile,'/app/data/seed.json');assert.equal(cfg.fallbackEnabled,false);assert.deepEqual(cfg.proxyAllowedUrls,['https://synthetic.example/v1/chat/completions']);assert.equal(cfg.upstreamModel,null)
  // 第二版：中继只有 community_open，没有成员白名单；也没有旧版成员名单文件。
  const relay=await readFile(path.join(home,'data/relay-config.toml'),'utf8');assert.match(relay,/community_open = true/);assert.match(relay,/pubkey_whitelist = \[\]/)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),[])
  await assert.rejects(readFile(path.join(home,'data/gateway-members.json'),'utf8'))
  // 重跑不丢已登记成员、不改口令。
  await writeFile(path.join(home,'data/gateway/members.json'),JSON.stringify(['a'.repeat(64)]));bash(script,env)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),['a'.repeat(64)])
  assert.equal(await readFile(path.join(home,'data/teacher-setup-code.txt'),'utf8'),token);assert.equal(await readFile(path.join(home,'data/gateway/seed.json'),'utf8'),seed)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('relay configure defaults closed and requires members unless explicitly opened',async()=>{
 const dir=await workspace();try{const script=path.join(dir,'relay/configure.mjs');let result=spawnSync(process.execPath,[script,'a'.repeat(64)],{encoding:'utf8',env:{...process.env,RELAY_COMMUNITY_OPEN:''}});assert.equal(result.status,0,result.stderr);assert.match(await readFile(path.join(dir,'relay/config.local.toml'),'utf8'),/community_open = false/);result=spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,RELAY_COMMUNITY_OPEN:''}});assert.notEqual(result.status,0)}finally{await rm(dir,{recursive:true,force:true})}
})
test('第二版部署目录与 README 里没有第一版已删功能的字样',async()=>{
 const banned=[[/备份槽/,'备份槽'],[/30078/,'30078'],[/身份槽/,'身份槽'],[/passkey/i,'passkey'],[/种子成员/,'种子成员'],[/MEMBER_PUBKEYS/,'MEMBER_PUBKEYS'],[/SELF_TEST_MEMBER/,'SELF_TEST_MEMBER'],[/VERIFY_MEMBER/,'VERIFY_MEMBER'],[/gateway-members\.json/,'gateway-members.json']]
 const files=[]
 async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.name==='data')continue;const full=path.join(directory,entry.name);if(entry.isDirectory())await walk(full);else if(/\.(sh|md|mjs|js|json|yaml|yml|example|toml)$/.test(entry.name)||entry.name==='.env.example')files.push(full)}}
 await walk(path.join(root,'deploy/home'))
 files.push(path.join(root,'deploy/home/README.md'))
 const found=[]
 for(const file of files){const text=await readFile(file,'utf8');for(const [pattern,label] of banned)if(pattern.test(text))found.push(path.relative(root,file)+' → '+label)}
 assert.deepEqual(found,[])
})
