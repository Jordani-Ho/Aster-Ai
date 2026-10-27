// 部署数据保命（V2-28）+ 口令与网关种子永远一致（V2-31）。
// setup.sh / update.sh 用它：
//   prepare  备份成员名单；把 seed.json 与 teacher-setup-code.txt 当成一对处理
//            （只缺一个不混用；改坏/哈希不一致直接报错退出，不能带不一致状态启动）
//   check    更新后核对成员人数与口令/种子没变（update.sh 用）
//   verify   结束时核对“口令文件哈希 == 种子 tokenHash”（setup.sh/update.sh 用）
// 只读写本机 data/，不打印口令内容，不联网。
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

const BACKUP = join('data', 'backup', 'last')
const MEMBERS = join('data', 'gateway', 'members.json')
const SEED = join('data', 'gateway', 'seed.json')
const CODE = join('data', 'setup', 'teacher-setup-code.txt')
const HTML = join('data', 'setup', 'teacher-setup.html')
const CORE_SEED = join('data', 'gateway', 'core-seed.json')
const CORE_CODE = join('data', 'setup', 'core-member-code.txt')
const CORE_HTML = join('data', 'setup', 'core-member.html')

const hash = text => createHash('sha256').update(text).digest('hex')
const log = text => console.log(text)

function read(file) { try { return existsSync(file) ? readFileSync(file, 'utf8') : null } catch { return null } }
function write(file, text) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text, { mode: 0o600 }); chmodSync(file, 0o600) }
function remove(file) { try { rmSync(file, { force: true }) } catch { /* 删不掉也不该拦住更新；verify 时会再报 */ } }

function members() {
  const text = read(MEMBERS)
  if (typeof text !== 'string') return []
  try { const value = JSON.parse(text); return Array.isArray(value) ? value : Array.isArray(value?.members) ? value.members : [] } catch { return [] }
}
function seed() {
  const text = read(SEED)
  if (typeof text !== 'string') return null
  try {
    const value = JSON.parse(text)
    if (!value || typeof value.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.tokenHash)) return null
    return { tokenHash: value.tokenHash, ...(typeof value.usedFor === 'string' && value.usedFor !== '' ? { usedFor: value.usedFor } : {}) }
  } catch { return null }
}
function coreSeed() {
  const text = read(CORE_SEED)
  if (typeof text !== 'string') return null
  try {
    const value = JSON.parse(text)
    if (!value || typeof value.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.tokenHash)) return null
    return { tokenHash: value.tokenHash, ...(typeof value.usedFor === 'string' && value.usedFor !== '' ? { usedFor: value.usedFor } : {}) }
  } catch { return null }
}
function codeText() { const text = read(CODE); return typeof text === 'string' ? text.trim() : null }
// “老师已登记”以种子的 usedFor（网关原子认领记录）为准。种子丢了就无从判断，
// 按“还没登记”重新生成一对（旧口令本来就已无法校验，成员名单不受影响）。
function registered(record = seed()) { return Boolean(record?.usedFor) }

function mismatchMessage() {
  return [
    '口令文件与网关种子不一致：',
    `  ${SEED} 的 tokenHash ≠ sha256(${CODE})`,
    '不能带着不一致的状态启动。请按顺序处理：',
    '  1) 先停掉正在跑的服务（docker compose --profile quick down，或固定域名模式 down）',
    `  2) 删除这三份文件：${SEED}  ${CODE}  ${HTML}`,
    '  3) 再跑 ./update.sh',
    '已有老师登记时成员名单会保留（只重建种子）；还没登记时会重新生成一对新口令。',
  ].join('\n')
}
function fatal(message) { console.error('错误：' + message); process.exit(1) }

function backupFile(file, name) {
  const text = read(file)
  if (typeof text !== 'string') return false
  mkdirSync(BACKUP, { recursive: true })
  writeFileSync(join(BACKUP, name), text, { mode: 0o600 })
  return true
}
function backupSeed(record) { if (record) backupFile(SEED, 'seed.json') }
function backupPair() { backupFile(SEED, 'seed.json'); backupFile(CODE, 'teacher-setup-code.txt') }
function restoreFile(name, file) {
  const text = read(join(BACKUP, name))
  if (typeof text !== 'string' || text.trim() === '') return false
  write(file, text)
  return true
}
function restorePair() {
  const seedText = read(join(BACKUP, 'seed.json')), code = (read(join(BACKUP, 'teacher-setup-code.txt')) ?? '').trim()
  if (typeof seedText !== 'string' || code === '') return false
  let record
  try { record = JSON.parse(seedText) } catch { return false }
  if (!record || typeof record.tokenHash !== 'string' || hash(code) !== record.tokenHash) return false
  write(SEED, seedText)
  write(CODE, code + '\n')
  log('提醒：口令与种子成对从上次备份恢复（旧二维码仍然有效）。')
  return true
}
function regeneratePair(reason) {
  const token = randomBytes(32).toString('base64url')
  write(SEED, JSON.stringify({ tokenHash: hash(token) }))
  write(CODE, token + '\n')
  remove(HTML)
  backupPair()
  log(`提醒：${reason}，已重新生成一对新口令与种子（旧口令作废，请重新扫码）。`)
}
function ensureSeedOnly() {
  const record = seed()
  if (!record) {
    const fresh = { tokenHash: hash(randomBytes(32).toString('base64url')) }
    write(SEED, JSON.stringify(fresh))
    backupSeed(fresh)
  } else {
    backupSeed(record)
  }
  remove(CODE)
  remove(HTML)
  log('提醒：已有老师登记，口令已作废；保留网关种子，不再生成登记口令。')
}

function prepareMembers() {
  const list = members()
  if (list.length > 0) backupFile(MEMBERS, 'members.json')
  if (list.length === 0 && read(join(BACKUP, 'members.json')) !== null) {
    const saved = JSON.parse(read(join(BACKUP, 'members.json')))
    const count=Array.isArray(saved)?saved.length:Array.isArray(saved?.members)?saved.members.length:0
    if (count > 0 && restoreFile('members.json', MEMBERS)) {
      log(`提醒：成员名单被删除或清空，已从上次备份恢复 ${count} 人（旧邀请仍然有效）。`)
    }
  }
}

function prepare() {
  prepareMembers()
  prepareCoreSeed()
  const record = seed()
  const code = codeText()
  const htmlExists = existsSync(HTML)
  const hasCode = code !== null
  const registeredNow = registered(record)
  if (record && hasCode) {
    if (hash(code) === record.tokenHash) {
      if (registeredNow) {
        remove(CODE); remove(HTML)
        log('提醒：已有老师登记，已删除作废的一次性口令与 teacher-setup.html。')
      } else {
        backupPair()
      }
    } else if (registeredNow) {
      // 已登记：种子是唯一来源，残留/改坏的口令文件都作废，删掉即可。
      backupSeed(record)
      remove(CODE); remove(HTML)
      log('提醒：已有老师登记，残留的一次性口令已作废并删除（以网关种子为准）。')
    } else {
      fatal(mismatchMessage())
    }
    return
  }
  if (record && !hasCode) {
    backupSeed(record)
    if (registeredNow) { if (htmlExists) remove(HTML) }
    else regeneratePair('口令文件不见了')
    return
  }
  if (!record) {
    // 种子不在或损坏：单独的 html 没有意义，先删掉。
    if (htmlExists) remove(HTML)
    if (hasCode) {
      if (registeredNow) { remove(CODE); ensureSeedOnly(); return }
      regeneratePair('网关种子不见了或已损坏')
      return
    }
    // 一对都不在：先按“成对备份”恢复；没有可用备份再重新生成一对。
    if (registeredNow) { ensureSeedOnly(); return }
    if (restorePair()) { backupPair(); return }
    regeneratePair('还没有口令与种子')
    return
  }
}

function prepareCoreSeed() {
  const record=coreSeed(),code=(read(CORE_CODE)??'').trim()
  if(record?.usedFor){remove(CORE_CODE);remove(CORE_HTML);log('提醒：核心成员已登记，已删除作废的核心成员登记口令与扫码页。');return}
  if(record&&code&&hash(code)===record.tokenHash){backupFile(CORE_SEED,'core-seed.json');backupFile(CORE_CODE,'core-member-code.txt');return}
  const token=randomBytes(32).toString('base64url'),fresh={tokenHash:hash(token)}
  write(CORE_SEED,JSON.stringify(fresh));write(CORE_CODE,token+'\n');remove(CORE_HTML)
  backupFile(CORE_SEED,'core-seed.json');backupFile(CORE_CODE,'core-member-code.txt')
  log('提醒：核心成员登记凭据缺失或不一致，已生成新的核心登记链接（旧链接失效）。')
}

function verify() {
  const record = seed()
  const code = codeText()
  const registeredNow = registered(record)
  if (code !== null) {
    if (!record) fatal(`种子文件缺失或损坏，但口令文件还在。\n${mismatchMessage()}`)
    if (hash(code) !== record.tokenHash) {
      if (registeredNow) {
        remove(CODE); remove(HTML)
        log('提醒：已有老师登记，残留的一次性口令已作废并删除（以网关种子为准）。')
        return
      }
      fatal(mismatchMessage())
    }
    if (registeredNow) {
      remove(CODE); remove(HTML)
      log('提醒：已有老师登记，已删除作废的一次性口令与 teacher-setup.html。')
      return
    }
    log('核对通过：口令文件与网关种子一致。')
    return
  }
  if (!registeredNow) fatal(`还没老师登记，但 ${CODE} 不见了；重跑 ./update.sh 会重新生成一对口令。`)
  if (existsSync(HTML)) remove(HTML)
  log('核对通过：老师已登记，没有待用口令。')
}

function countMembers() { return members().length }

function check(expectedMembers, expectedSeed, expectedCode) {
  const before = expectedMembers === '' ? 0 : Number(expectedMembers)
  if (Number.isFinite(before) && before > 0 && countMembers() < before) {
    restoreFile('members.json', MEMBERS)
    fatal(`成员名单从 ${before} 人变少（更新脚本不应该动名单）。已尝试从备份恢复；请检查 data/gateway/members.json。`)
  }
  if (expectedSeed && hash(read(SEED) ?? '') !== expectedSeed) fatal('口令种子在更新过程中变了（更新脚本不应该动种子）。请检查 data/gateway/seed.json 与 data/setup/teacher-setup-code.txt。')
  if (expectedCode && hash(read(CODE) ?? '') !== expectedCode) fatal('口令文件在更新过程中变了（更新脚本不应该动口令）。请检查 data/setup/teacher-setup-code.txt。')
  log(`核对通过：成员名单 ${countMembers()} 人、口令与种子没变。`)
}

const [mode, ...args] = process.argv.slice(2)
if (mode === 'prepare') prepare()
else if (mode === 'verify') verify()
else if (mode === 'check') check(args[0] ?? '', args[1] ?? '', args[2] ?? '')
else { console.error('用法：node scripts/safeguard-data.mjs prepare|verify|check'); process.exit(2) }
