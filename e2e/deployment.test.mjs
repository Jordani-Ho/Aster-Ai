import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm} from 'node:fs/promises'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {root} from './process.mjs'
const linux=p=>p.replace(/^([A-Z]):/i,(_,letter)=>'/mnt/'+letter.toLowerCase()).replaceAll('\\','/')
async function workspace(){await mkdir(path.join(root,'.cache/e2e'),{recursive:true});const dir=await mkdtemp(path.join(root,'.cache/e2e/setup-'));for(const file of ['deploy/home/setup.sh','deploy/home/scripts/generate-gateway.mjs','gateway/members.js','relay/configure.mjs','package.json']){await mkdir(path.dirname(path.join(dir,file)),{recursive:true});await copyFile(path.join(root,file),path.join(dir,file))}return dir}
function bash(script,env){const result=process.platform==='win32'?spawnSync('wsl.exe',['-d','Ubuntu','--exec','env',...Object.entries(env).map(([k,v])=>k+'='+v),'bash',linux(script)],{encoding:'utf8'}):spawnSync('bash',[script],{encoding:'utf8',env:{...process.env,...env}});assert.equal(result.status,0,result.stderr);return result.stdout}
test('existing setup supports phone deployment code and rerun retains members and token; no real Docker used',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=path.join(dir,'fake-bin')
 try{
  await mkdir(bin);await writeFile(path.join(bin,'docker'),'#!/bin/sh\nexit 0\n',{mode:0o755})
  if(process.platform==='win32'){const result=spawnSync('wsl.exe',['-d','Ubuntu','--exec','chmod','+x',linux(path.join(bin,'docker'))]);assert.equal(result.status,0)}
  await writeFile(path.join(home,'.env'),'APP_DOMAIN=app.example\nRELAY_DOMAIN=relay.example\nVAPID_SUBJECT=mailto:synthetic@example.invalid\nVAPID_PUBLIC_KEY=synthetic\nVAPID_PRIVATE_KEY=synthetic\nSELF_TEST_MEMBER=0\nMEMBER_PUBKEYS=\n')
  const env={SKIP_BUILD:'1',PATH:process.platform==='win32'?linux(bin)+':/usr/local/bin:/usr/bin:/bin':bin+':'+process.env.PATH},script=path.join(home,'setup.sh'),out=bash(script,env)
  const token=await readFile(path.join(home,'data/teacher-setup-code.txt'),'utf8'),seed=await readFile(path.join(home,'data/gateway/seed.json'),'utf8')
  assert.ok(token.trim().length>=40);assert.ok(!seed.includes(token.trim()));assert.ok(!out.includes(token.trim()))
  const cfg=JSON.parse(await readFile(path.join(home,'data/gateway-config.json'),'utf8'));assert.equal(cfg.membersFile,'/app/data/members.json');assert.equal(cfg.seedTokenFile,'/app/data/seed.json')
  assert.match(await readFile(path.join(home,'data/relay-config.toml'),'utf8'),/community_open = true/)
  await writeFile(path.join(home,'data/gateway/members.json'),JSON.stringify(['a'.repeat(64)]));bash(script,env)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),['a'.repeat(64)])
  assert.equal(await readFile(path.join(home,'data/teacher-setup-code.txt'),'utf8'),token);assert.equal(await readFile(path.join(home,'data/gateway/seed.json'),'utf8'),seed)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('relay configure defaults closed and requires members unless explicitly opened',async()=>{
 const dir=await workspace();try{const script=path.join(dir,'relay/configure.mjs');let result=spawnSync(process.execPath,[script,'a'.repeat(64)],{encoding:'utf8',env:{...process.env,RELAY_COMMUNITY_OPEN:''}});assert.equal(result.status,0,result.stderr);assert.match(await readFile(path.join(dir,'relay/config.local.toml'),'utf8'),/community_open = false/);result=spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,RELAY_COMMUNITY_OPEN:''}});assert.notEqual(result.status,0)}finally{await rm(dir,{recursive:true,force:true})}
})
