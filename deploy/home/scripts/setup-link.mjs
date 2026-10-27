// V2-31：还没老师登记时，生成“扫码登记”的二维码：
//   - 终端直接打印（用同一个实现渲染成 ANSI 黑白块）；
//   - 同时写一份本机网页 data/setup/teacher-setup.html（只在部署电脑上打开）。
// 二维码内容 = 部署网址 + #setup=<口令>；口令只放在 # 后（浏览器不发给服务器），
// 因此终端/HTML/日志里都不出现口令明文。
// 只在本机生成，不联网；已有老师登记（seed.usedFor）或口令已删时不生成。
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const qrcode = require('./vendor/qrcode-generator-1.4.4.cjs')

const SETUP_DIR = join('data', 'setup')
const SEED = join('data', 'gateway', 'seed.json')
const CODE = join(SETUP_DIR, 'teacher-setup-code.txt')
const HTML = join(SETUP_DIR, 'teacher-setup.html')
const CORE_SEED = join('data', 'gateway', 'core-seed.json')
const CORE_CODE = join(SETUP_DIR, 'core-member-code.txt')
const CORE_HTML = join(SETUP_DIR, 'core-member.html')

function read(file) { try { return existsSync(file) ? readFileSync(file, 'utf8') : null } catch { return null } }

function payloadFor(baseUrl, token) { return `${baseUrl.replace(/\/+$/, '')}/#setup=${encodeURIComponent(token)}` }

// 终端二维码：每格 2 个空格宽，黑格黑底、白格白底（普通 8 色终端就能扫）。
function printTerminalQr(qr) {
  const quiet = 2, count = qr.getModuleCount(), width = (count + quiet * 2) * 2
  const dark = '\x1b[40m  \x1b[0m', light = '\x1b[107m  \x1b[0m'
  const rows = []
  for (let r = -quiet; r < count + quiet; r += 1) {
    let line = ''
    for (let c = -quiet; c < count + quiet; c += 1) {
      const inside = r >= 0 && r < count && c >= 0 && c < count
      line += inside && qr.isDark(r, c) ? dark : light
    }
    rows.push(line)
  }
  console.log(rows.join('\n'))
}

function escapeHtml(text) { return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }

function writeHtml({ svg, baseUrl, tokenHash }) {
  const html = `<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="setup-token-sha256" content="${tokenHash}">
<title>老师登记 · 知衡</title>
<style>
  body { margin: 0; background: #f6f5ef; color: #1f2a24; font-family: system-ui, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 28px 20px 40px; text-align: center; }
  h1 { font-size: 24px; margin: 4px 0 8px; }
  p { line-height: 1.8; margin: 8px 0; }
  .card { background: #fffdf8; border: 1px solid #e3ddd1; border-radius: 20px; padding: 22px; margin: 18px 0; }
  .qr { background: #fff; display: inline-block; padding: 10px; border-radius: 12px; line-height: 0; }
  .url { font-size: 14px; color: #6b746c; word-break: break-all; }
  .hint { font-size: 14px; color: #6b746c; }
</style>
<main>
  <h1>用老师的手机扫码登记</h1>
  <p>这个页面只在本机打开，二维码里带一次性登记口令。</p>
  <div class="card">
    <div class="qr">${svg}</div>
  </div>
  <p class="hint">手机扫码后进入建馆第 1 步接入模型，第 2 步口令会自动填好，点“登记”即可。</p>
  <p class="url">部署网址：${escapeHtml(baseUrl)}</p>
  <p class="hint">扫不开二维码时：在手机上打开上面的网址，按建馆第 2 步手动粘贴 data/setup/teacher-setup-code.txt 里的口令。</p>
  <p class="hint">登记成功后，这份口令与这个页面会被自动删除；口令用过就作废。</p>
</main>
</html>
`
  mkdirSync(dirname(HTML), { recursive: true })
  writeFileSync(HTML, html, { mode: 0o600 })
  chmodSync(HTML, 0o600)
}

function writeCoreHtml({svg,baseUrl,tokenHash}){
  const html=`<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="core-token-sha256" content="${tokenHash}">
<title>核心成员登记 · 知衡</title>
<style>
  body { margin: 0; background: #f6f5ef; color: #1f2a24; font-family: system-ui, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 28px 20px 40px; text-align: center; }
  h1 { font-size: 24px; margin: 4px 0 8px; }
  p { line-height: 1.8; margin: 8px 0; }
  .card { background: #fffdf8; border: 1px solid #e3ddd1; border-radius: 20px; padding: 22px; margin: 18px 0; }
  .qr { background: #fff; display: inline-block; padding: 10px; border-radius: 12px; line-height: 0; }
  .hint { font-size: 14px; color: #6b746c; }
</style>
<main>
  <h1>发起人用自己的手机扫码登记</h1>
  <p>这是一次性核心成员登记，只由部署者在本机生成。</p>
  <div class="card"><div class="qr">${svg}</div></div>
  <p class="hint">扫码后登记为核心成员，原有使用身份不变。</p>
  <p class="hint">登记成功后，链接和二维码会自动作废。</p>
  <p class="hint">部署网址：${escapeHtml(baseUrl)}</p>
</main>
</html>
`
  mkdirSync(dirname(CORE_HTML),{recursive:true})
  writeFileSync(CORE_HTML,html,{mode:0o600})
  chmodSync(CORE_HTML,0o600)
}

function qrFor(payload){const qr=qrcode(0,'M');qr.addData(payload);qr.make();return qr}

function main() {
  const baseUrl = (process.env.APP_URL ?? '').trim()
  if (baseUrl === '' || !/^https?:\/\//.test(baseUrl) || baseUrl.includes('placeholder.invalid')) {
    console.log('提醒：还没有可用的部署网址（首次 quick-start 配置阶段），稍后会自动生成扫码二维码。')
    return
  }
  const seedText=read(SEED),coreSeedText=read(CORE_SEED)
  let record=null,coreRecord=null
  try{record=seedText?JSON.parse(seedText):null}catch{}
  try{coreRecord=coreSeedText?JSON.parse(coreSeedText):null}catch{}
  const token=(read(CODE)??'').trim()
  if(!record?.usedFor&&token){
    const qr=qrFor(payloadFor(baseUrl,token))
    console.log('\n还没老师登记。用老师的手机扫下面的二维码，建馆第 2 步会自动填好口令：')
    printTerminalQr(qr)
    console.log(`二维码只在本机生成；口令不打印、不写日志。也可以打开 ${HTML} 扫码。`)
    writeHtml({svg:qr.createSvgTag(8,32),baseUrl,tokenHash:createHash('sha256').update(token).digest('hex')})
  }
  const coreToken=(read(CORE_CODE)??'').trim()
  if(!coreRecord?.usedFor&&coreToken){
    const qr=qrFor(`${baseUrl.replace(/\/+$/,'')}/#core=${encodeURIComponent(coreToken)}`)
    console.log('\n核心成员尚未登记。发起人用自己的手机扫下面的二维码：')
    printTerminalQr(qr)
    console.log(`核心登记二维码只在本机生成；口令不打印、不写日志。也可以打开 ${CORE_HTML} 扫码。`)
    writeCoreHtml({svg:qr.createSvgTag(8,32),baseUrl,tokenHash:createHash('sha256').update(coreToken).digest('hex')})
  }
}

try {
  main()
} catch (error) {
  // 二维码只是省事，不影响“手动粘贴口令”这条老路；失败不要拦住部署。
  console.warn('提醒：二维码没有生成成功（' + (error instanceof Error ? error.message : String(error)) + '），仍可在建馆第 2 步手动粘贴口令。')
}
