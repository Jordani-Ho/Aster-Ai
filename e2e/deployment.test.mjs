import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm,readdir} from 'node:fs/promises'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {root} from './process.mjs'
const linux=p=>p.replace(/^([A-Z]):/i,(_,letter)=>'/mnt/'+letter.toLowerCase()).replaceAll('\\','/')
const FILES=['deploy/home/setup.sh','deploy/home/update.sh','deploy/home/scripts/generate-gateway.mjs','deploy/home/scripts/safeguard-data.mjs','gateway/members.js','relay/configure.mjs','package.json']
async function workspace(){await mkdir(path.join(root,'.cache/e2e'),{recursive:true});const dir=await mkdtemp(path.join(root,'.cache/e2e/setup-'));for(const file of FILES){await mkdir(path.dirname(path.join(dir,file)),{recursive:true});await copyFile(path.join(root,file),path.join(dir,file))}return dir}
function bash(script,env){const result=process.platform==='win32'?spawnSync('wsl.exe',['-d','Ubuntu','--exec','env',...Object.entries(env).map(([k,v])=>k+'='+v),'bash',linux(script)],{encoding:'utf8'}):spawnSync('bash',[script],{encoding:'utf8',env:{...process.env,...env}});assert.equal(result.status,0,result.stderr);return result.stdout}
const ENV_TEXT='APP_DOMAIN=app.example\nRELAY_DOMAIN=relay.example\nVAPID_SUBJECT=mailto:synthetic@example.invalid\nVAPID_PUBLIC_KEY=synthetic\nVAPID_PRIVATE_KEY=synthetic\nMODEL_FALLBACK_ENABLED=false\nMODEL_PROXY_ALLOWED_URLS=https://synthetic.example/v1/chat/completions\nRELAY_COMMUNITY_OPEN=true\n'
async function fakeBin(dir){const bin=path.join(dir,'fake-bin');await mkdir(bin,{recursive:true});await writeFile(path.join(bin,'docker'),'#!/bin/sh\nexit 0\n',{mode:0o755});if(process.platform==='win32'){const result=spawnSync('wsl.exe',['-d','Ubuntu','--exec','chmod','+x',linux(path.join(bin,'docker'))]);assert.equal(result.status,0)}return bin}
function envFor(bin){return {SKIP_BUILD:'1',PATH:process.platform==='win32'?linux(bin)+':/usr/local/bin:/usr/bin:/bin':bin+':'+process.env.PATH}}
test('第二版 setup 不写成员白名单：开放模式起中继、生成一次性口令、重跑保留成员与口令；不用真实 Docker',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin),script=path.join(home,'setup.sh'),out=bash(script,env)
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
// V2-28：更新环境时名单/口令被误删，不能就此变成空名单；要从本机备份恢复并说清楚。
test('V2-28 误删成员名单或口令后重跑 setup：从上次备份恢复，旧邀请仍有效',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin),script=path.join(home,'setup.sh')
  bash(script,env)
  const token=await readFile(path.join(home,'data/teacher-setup-code.txt'),'utf8'),seed=await readFile(path.join(home,'data/gateway/seed.json'),'utf8')
  await writeFile(path.join(home,'data/gateway/members.json'),JSON.stringify(['b'.repeat(64),'c'.repeat(64)]))
  bash(script,env) // 这次会把名单/口令备份到 data/backup/last
  await rm(path.join(home,'data/gateway/members.json'));await rm(path.join(home,'data/gateway/seed.json'));await rm(path.join(home,'data/teacher-setup-code.txt'))
  const out=bash(script,env)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),['b'.repeat(64),'c'.repeat(64)])
  assert.equal(await readFile(path.join(home,'data/teacher-setup-code.txt'),'utf8'),token)
  assert.equal(await readFile(path.join(home,'data/gateway/seed.json'),'utf8'),seed)
  assert.match(out,/恢复/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
// V2-28：部署配了社区网关模型时，网页才知道可以“先用社区模型开始”。
test('V2-28 部署配了社区网关模型才写 COMMUNITY_MODEL=1，否则写 0',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin),script=path.join(home,'setup.sh')
  bash(script,env)
  let envText=await readFile(path.join(home,'.env'),'utf8')
  assert.match(envText,/^COMMUNITY_MODEL=0$/m)
  await writeFile(path.join(home,'.env'),ENV_TEXT.replace('MODEL_FALLBACK_ENABLED=false','MODEL_FALLBACK_ENABLED=true')+'UPSTREAM_API_KEY=SYNTHETIC_UPSTREAM\nUPSTREAM_BASE_URL=https://upstream.synthetic.example/v1\nUPSTREAM_MODEL=synthetic-upstream\n')
  bash(script,env)
  envText=await readFile(path.join(home,'.env'),'utf8')
  assert.match(envText,/^COMMUNITY_MODEL=1$/m)
  const cfg=JSON.parse(await readFile(path.join(home,'data/gateway-config.json'),'utf8'));assert.equal(cfg.upstreamBaseUrl,'https://upstream.synthetic.example/v1');assert.equal(cfg.upstreamModel,'synthetic-upstream')
 }finally{await rm(dir,{recursive:true,force:true})}
})
// V2-28：更新脚本 = 备份 → 重新生成配置与重建 → 核对名单/口令没变；误删也先恢复。
test('V2-28 更新脚本：成员名单与一次性口令不变、旧邀请仍有效，误删先恢复',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin),setup=path.join(home,'setup.sh'),update=path.join(home,'update.sh')
  bash(setup,env)
  const token=await readFile(path.join(home,'data/teacher-setup-code.txt'),'utf8'),seed=await readFile(path.join(home,'data/gateway/seed.json'),'utf8')
  await writeFile(path.join(home,'data/gateway/members.json'),JSON.stringify(['d'.repeat(64),'e'.repeat(64),'f'.repeat(64)]))
  const out=bash(update,env)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),['d'.repeat(64),'e'.repeat(64),'f'.repeat(64)])
  assert.equal(await readFile(path.join(home,'data/teacher-setup-code.txt'),'utf8'),token)
  assert.equal(await readFile(path.join(home,'data/gateway/seed.json'),'utf8'),seed)
  assert.match(out,/3 人/);assert.match(out,/口令没有变|口令未变/)
  // 误删名单后再跑一次更新：先恢复，再核对。
  await rm(path.join(home,'data/gateway/members.json'))
  const again=bash(update,env)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),['d'.repeat(64),'e'.repeat(64),'f'.repeat(64)])
  assert.match(again,/恢复/)
  const backups=await readdir(path.join(home,'data/backup/last'))
  assert.ok(backups.some(name=>name.includes('members.json')))
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
