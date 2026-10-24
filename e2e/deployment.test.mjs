import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm,readdir} from 'node:fs/promises'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {root} from './process.mjs'
const linux=p=>p.replace(/^([A-Z]):/i,(_,letter)=>'/mnt/'+letter.toLowerCase()).replaceAll('\\','/')
const FILES=['deploy/home/setup.sh','deploy/home/update.sh','deploy/home/verify.sh','deploy/home/scripts/generate-gateway.mjs','deploy/home/scripts/safeguard-data.mjs','deploy/home/scripts/setup-link.mjs','deploy/home/scripts/vendor/qrcode-generator-1.4.4.cjs','gateway/members.js','relay/configure.mjs','package.json']
async function workspace(){await mkdir(path.join(root,'.cache/e2e'),{recursive:true});const dir=await mkdtemp(path.join(root,'.cache/e2e/setup-'));for(const file of FILES){await mkdir(path.dirname(path.join(dir,file)),{recursive:true});await copyFile(path.join(root,file),path.join(dir,file))}return dir}
function bash(script,env){const result=process.platform==='win32'?spawnSync('wsl.exe',['-d','Ubuntu','--exec','env',...Object.entries(env).map(([k,v])=>k+'='+v),'bash',linux(script)],{encoding:'utf8'}):spawnSync('bash',[script],{encoding:'utf8',env:{...process.env,...env}});assert.equal(result.status,0,result.stderr);return result.stdout}
// 期望失败时用这个：不 assert 退出码，返回 status/stdout/stderr 自己判断。
function bashRaw(script,env){return process.platform==='win32'?spawnSync('wsl.exe',['-d','Ubuntu','--exec','env',...Object.entries(env).map(([k,v])=>k+'='+v),'bash',linux(script)],{encoding:'utf8'}):spawnSync('bash',[script],{encoding:'utf8',env:{...process.env,...env}})}
const CODE='data/setup/teacher-setup-code.txt',HTML='data/setup/teacher-setup.html'
const ENV_TEXT='APP_DOMAIN=app.example\nRELAY_DOMAIN=relay.example\nVAPID_SUBJECT=mailto:synthetic@example.invalid\nVAPID_PUBLIC_KEY=synthetic\nVAPID_PRIVATE_KEY=synthetic\nMODEL_FALLBACK_ENABLED=false\nMODEL_PROXY_ALLOWED_URLS=https://synthetic.example/v1/chat/completions\nRELAY_COMMUNITY_OPEN=true\n'
async function fakeBin(dir){const bin=path.join(dir,'fake-bin');await mkdir(bin,{recursive:true});await writeFile(path.join(bin,'docker'),'#!/bin/sh\nif [ -n "${DOCKER_FAKE_LOG:-}" ]; then printf \'%s\\n\' "$*" >> "$DOCKER_FAKE_LOG"; fi\nexit 0\n',{mode:0o755});if(process.platform==='win32'){const result=spawnSync('wsl.exe',['-d','Ubuntu','--exec','chmod','+x',linux(path.join(bin,'docker'))]);assert.equal(result.status,0)}return bin}
function envFor(bin){return {SKIP_BUILD:'1',PATH:process.platform==='win32'?linux(bin)+':/usr/local/bin:/usr/bin:/bin':bin+':'+process.env.PATH}}
test('第二版 setup 不写成员白名单：开放模式起中继、生成一次性口令、重跑保留成员与口令；不用真实 Docker',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin),script=path.join(home,'setup.sh'),out=bash(script,env)
  const token=await readFile(path.join(home,'data/setup/teacher-setup-code.txt'),'utf8'),seed=await readFile(path.join(home,'data/gateway/seed.json'),'utf8')
  assert.ok(token.trim().length>=40);assert.ok(!seed.includes(token.trim()));assert.ok(!out.includes(token.trim()))
  const cfg=JSON.parse(await readFile(path.join(home,'data/gateway-config.json'),'utf8'));assert.equal(cfg.membersFile,'/app/data/members.json');assert.equal(cfg.seedTokenFile,'/app/data/seed.json');assert.equal(cfg.fallbackEnabled,false);assert.deepEqual(cfg.proxyAllowedUrls,['https://synthetic.example/v1/chat/completions']);assert.equal(cfg.upstreamModel,null)
  // 第二版：中继只有 community_open，没有成员白名单；也没有旧版成员名单文件。
  const relay=await readFile(path.join(home,'data/relay-config.toml'),'utf8');assert.match(relay,/community_open = true/);assert.match(relay,/pubkey_whitelist = \[\]/)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),[])
  await assert.rejects(readFile(path.join(home,'data/gateway-members.json'),'utf8'))
  // 重跑不丢已登记成员、不改口令。
  await writeFile(path.join(home,'data/gateway/members.json'),JSON.stringify(['a'.repeat(64)]));bash(script,env)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),['a'.repeat(64)])
  assert.equal(await readFile(path.join(home,'data/setup/teacher-setup-code.txt'),'utf8'),token);assert.equal(await readFile(path.join(home,'data/gateway/seed.json'),'utf8'),seed)
 }finally{await rm(dir,{recursive:true,force:true})}
})
// V2-28：更新环境时名单/口令被误删，不能就此变成空名单；要从本机备份恢复并说清楚。
test('V2-28 误删成员名单或口令后重跑 setup：从上次备份恢复，旧邀请仍有效',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin),script=path.join(home,'setup.sh')
  bash(script,env)
  const token=await readFile(path.join(home,'data/setup/teacher-setup-code.txt'),'utf8'),seed=await readFile(path.join(home,'data/gateway/seed.json'),'utf8')
  await writeFile(path.join(home,'data/gateway/members.json'),JSON.stringify(['b'.repeat(64),'c'.repeat(64)]))
  bash(script,env) // 这次会把名单/口令备份到 data/backup/last
  await rm(path.join(home,'data/gateway/members.json'));await rm(path.join(home,'data/gateway/seed.json'));await rm(path.join(home,'data/setup/teacher-setup-code.txt'))
  const out=bash(script,env)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),['b'.repeat(64),'c'.repeat(64)])
  assert.equal(await readFile(path.join(home,'data/setup/teacher-setup-code.txt'),'utf8'),token)
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
  const token=await readFile(path.join(home,'data/setup/teacher-setup-code.txt'),'utf8'),seed=await readFile(path.join(home,'data/gateway/seed.json'),'utf8')
  await writeFile(path.join(home,'data/gateway/members.json'),JSON.stringify(['d'.repeat(64),'e'.repeat(64),'f'.repeat(64)]))
  const out=bash(update,env)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),['d'.repeat(64),'e'.repeat(64),'f'.repeat(64)])
  assert.equal(await readFile(path.join(home,'data/setup/teacher-setup-code.txt'),'utf8'),token)
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
// V2-29：版本号必须由宿主机算好、经容器环境变量带进 web 启动构建（镜像里没有 .git），不能回退成 unknown。
test('V2-29 版本号：宿主机短提交号写进 .env，再经 compose 传给 web 容器启动构建',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  const script=path.join(home,'setup.sh')
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  // 1) 宿主机显式传入（CI 与本测试可控）：setup.sh 原样写回 .env
  bash(script,{...envFor(bin),APP_VERSION:'deadbee',APP_BUILD_DATE:'01-02'})
  let envText=await readFile(path.join(home,'.env'),'utf8')
  assert.match(envText,/^APP_VERSION=deadbee$/m)
  assert.match(envText,/^APP_BUILD_DATE=01-02$/m)
  // 2) compose 把这两个变量交给 web 容器；entrypoint 在容器启动时 npm run build 读它们
  const compose=await readFile(path.join(root,'deploy/home/compose.yaml'),'utf8')
  assert.match(compose,/APP_VERSION: \$\{APP_VERSION/)
  assert.match(compose,/APP_BUILD_DATE: \$\{APP_BUILD_DATE/)
  const entry=await readFile(path.join(root,'deploy/home/web/entrypoint.sh'),'utf8')
  assert.match(entry,/npm run build/)
  const dockerfile=await readFile(path.join(root,'deploy/home/web/Dockerfile'),'utf8')
  assert.match(dockerfile,/ARG APP_VERSION/)
  assert.match(dockerfile,/ENV APP_VERSION=\$\{APP_VERSION\}/)
  // 3) 不显式给值：setup.sh 在宿主机从 git 取短提交号；取不到（如 WSL 直接跑 Windows worktree）写 unknown
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  bash(script,envFor(bin))
  envText=await readFile(path.join(home,'.env'),'utf8')
  let expected=null
  if(process.platform==='win32'){
    const wsl=spawnSync('wsl.exe',['-d','Ubuntu','--exec','git','-C',linux(home),'rev-parse','--short','HEAD'],{encoding:'utf8'})
    expected=wsl.status===0?wsl.stdout.trim():null
  }else{
    const host=spawnSync('git',['rev-parse','--short','HEAD'],{cwd:root,encoding:'utf8'})
    expected=host.status===0?host.stdout.trim():null
  }
  assert.equal(/^APP_VERSION=(.*)$/m.exec(envText)?.[1].trim(),expected??'unknown')
  assert.match(envText,/^APP_BUILD_DATE=\d{2}-\d{2}$/m)
 }finally{await rm(dir,{recursive:true,force:true})}
})
// V2-31：还没老师登记时，终端打印二维码并生成本机 teacher-setup.html；口令不以明文出现在终端/HTML。
test('V2-31 全新部署：终端与 teacher-setup.html 都有二维码，口令只在二维码里',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin),setup=path.join(home,'setup.sh'),out=bash(setup,env)
  const token=(await readFile(path.join(home,CODE),'utf8')).trim()
  assert.ok(token.length>=40)
  assert.ok(!out.includes(token),'终端不应打印口令明文')
  assert.match(out,/二维码/)
  assert.ok(out.includes('\x1b[')||/[▀█]/.test(out),'终端应有二维码块')
  const html=await readFile(path.join(home,HTML),'utf8')
  assert.ok(html.includes('https://app.example'))
  assert.ok(!html.includes(token),'HTML 不应写口令明文')
  assert.ok(html.includes('<svg'))
  const marker=/name="setup-token-sha256" content="([0-9a-f]{64})"/.exec(html)
  assert.equal(marker[1],createHash('sha256').update(token).digest('hex'))
  // 还没登记时重跑：保留同一对 seed/口令（二维码与口令绑定，不能每次换）。
  const seed=await readFile(path.join(home,'data/gateway/seed.json'),'utf8')
  bash(setup,env)
  assert.equal((await readFile(path.join(home,CODE),'utf8')).trim(),token)
  assert.equal(await readFile(path.join(home,'data/gateway/seed.json'),'utf8'),seed)
 }finally{await rm(dir,{recursive:true,force:true})}
})
// V2-31：seed 与口令只能成对；只缺一个时不混用；已有老师时口令作废。
test('V2-31 只删 seed 或只删口令：update.sh 后哈希一致，不出现一新一旧',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin),setup=path.join(home,'setup.sh'),update=path.join(home,'update.sh'),seedFile=path.join(home,'data/gateway/seed.json')
  bash(setup,env)
  // 只删口令（还没老师登记）→ 重新生成一对，哈希一致
  await rm(path.join(home,CODE))
  bash(update,env)
  const token2=(await readFile(path.join(home,CODE),'utf8')).trim()
  const seed2=JSON.parse(await readFile(seedFile,'utf8'))
  assert.equal(seed2.tokenHash,createHash('sha256').update(token2).digest('hex'))
  assert.equal(seed2.usedFor,undefined)
  // 只删 seed → 重新生成一对，哈希一致
  await rm(seedFile)
  bash(update,env)
  const token3=(await readFile(path.join(home,CODE),'utf8')).trim()
  const seed3=JSON.parse(await readFile(seedFile,'utf8'))
  assert.equal(seed3.tokenHash,createHash('sha256').update(token3).digest('hex'))
  assert.ok(await readFile(path.join(home,HTML),'utf8'))
  // 已有老师登记：保留种子、删掉孤立口令与 html，不再生成二维码
  const used={tokenHash:seed3.tokenHash,usedFor:'a'.repeat(64)}
  await writeFile(seedFile,JSON.stringify(used))
  await writeFile(path.join(home,CODE),'OLD_ORPHAN_TOKEN\n')
  await writeFile(path.join(home,HTML),'<html>old</html>')
  const out=bash(update,env)
  assert.deepEqual(JSON.parse(await readFile(seedFile,'utf8')),used)
  await assert.rejects(readFile(path.join(home,CODE)))
  await assert.rejects(readFile(path.join(home,HTML)))
  assert.ok(!out.includes('OLD_ORPHAN_TOKEN'))
 }finally{await rm(dir,{recursive:true,force:true})}
})
// V2-31：两份都在但哈希对不上（人为改坏口令）→ 报错退出、说明怎么处理、不启动。
test('V2-31 口令与种子不一致：update.sh 报错退出并说明怎么处理',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const log=path.join(dir,'docker.log')
  const env={...envFor(bin),DOCKER_FAKE_LOG:process.platform==='win32'?linux(log):log}
  bash(path.join(home,'setup.sh'),env)
  await writeFile(path.join(home,CODE),'TAMPERED_TOKEN\n')
  const bad=bashRaw(path.join(home,'update.sh'),env)
  assert.notEqual(bad.status,0)
  const text=(bad.stdout??'')+(bad.stderr??'')
  assert.match(text,/不一致/)
  assert.match(text,/seed\.json/)
  assert.match(text,/teacher-setup-code\.txt/)
  assert.match(text,/update\.sh/)
  const calls=await readFile(log,'utf8')
  assert.ok(!/compose.*\b(up|build)\b/.test(calls),'不一致时不应该启动容器')
 }finally{await rm(dir,{recursive:true,force:true})}
})
// V2-31 审核补充：名单被重置成 0 人但 self-member.json 还在时，verify 以前只在首次生成时写名单 → 403。
// 现在每次都幂等补回自测成员公钥（去重），verify 仍能全部通过。
test('V2-31 自测成员：self-member.json 已在、members.json 为空时 verify 幂等补回并全部通过',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin)
  bash(path.join(home,'setup.sh'),env)
  const secret='1'.repeat(64),pubkey='2'.repeat(64)
  await writeFile(path.join(home,'data/self-member.json'),JSON.stringify({secret,pubkey}))
  await writeFile(path.join(home,'data/gateway/members.json'),'[]')
  const out=bash(path.join(home,'verify.sh'),env)
  assert.match(out,/全部通过/)
  assert.match(out,/已把验收自测成员补进网关成员名单/)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),[pubkey])
  // 再跑一遍：幂等，不会重复添加、仍然通过。
  const again=bash(path.join(home,'verify.sh'),env)
  assert.match(again,/全部通过/)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),[pubkey])
 }finally{await rm(dir,{recursive:true,force:true})}
})
// V2-31 审核补充：update.sh 的顺序（prepare 恢复 → setup → verify 补自测成员 → check 只核对）
// 保证 verify 刚补进去的自测成员不会被后面的名单恢复覆盖。
test('V2-31 update 顺序：verify 先补自测成员，check 不覆盖',async()=>{
 const dir=await workspace(),home=path.join(dir,'deploy/home'),bin=await fakeBin(dir)
 try{
  await writeFile(path.join(home,'.env'),ENV_TEXT)
  const env=envFor(bin),pubkey='3'.repeat(64)
  bash(path.join(home,'setup.sh'),env)
  await writeFile(path.join(home,'data/self-member.json'),JSON.stringify({secret:'4'.repeat(64),pubkey}))
  await writeFile(path.join(home,'data/gateway/members.json'),'[]')
  const out=bash(path.join(home,'update.sh'),env)
  assert.match(out,/全部通过/)
  assert.match(out,/成员名单：1 人（更新前 0 人）/)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),[pubkey])
  const again=bash(path.join(home,'update.sh'),env)
  assert.deepEqual(JSON.parse(await readFile(path.join(home,'data/gateway/members.json'),'utf8')),[pubkey])
  assert.match(again,/成员名单：1 人（更新前 1 人）/)
 }finally{await rm(dir,{recursive:true,force:true})}
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
