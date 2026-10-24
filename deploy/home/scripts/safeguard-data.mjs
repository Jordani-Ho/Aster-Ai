// 部署数据保命（V2-28）：成员名单、一次性口令种子、登记口令。
// setup.sh / update.sh 在重新生成配置前后调用，避免“把 members.json 删了 → 重生成空名单 → 旧邀请失效”。
// 用法（在 deploy/home 目录下）：
//   node scripts/safeguard-data.mjs prepare
//     备份当前可用数据到 data/backup/last/；若当前文件被删/清空但备份里有，就先恢复并提示。
//   node scripts/safeguard-data.mjs check <membersBefore> <seedSha256> <codeSha256>
//     核对更新后的名单人数与口令种子；变少/变了就恢复并退出 1。空字符串表示“更新前就没有，不核对”。
// 只读写本机 data/，不打印密钥内容，不联网。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

const BACKUP = join('data', 'backup', 'last')
const MEMBERS = join('data', 'gateway', 'members.json')
const SEED = join('data', 'gateway', 'seed.json')
const CODE = join('data', 'teacher-setup-code.txt')

function read(file) { try { return existsSync(file) ? readFileSync(file, 'utf8') : null } catch { return null } }
function sha(text) { return createHash('sha256').update(text).digest('hex') }
function usableMembers(text) {
  if (typeof text !== 'string') return null
  try { const value = JSON.parse(text); return Array.isArray(value) && value.length > 0 ? value : null } catch { return null }
}
function usableText(text) { return typeof text === 'string' && text.trim() !== '' ? text : null }

const FILES = { 'members.json': MEMBERS, 'seed.json': SEED, 'teacher-setup-code.txt': CODE }

function backup(name) {
  const target = join(BACKUP, name)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(FILES[name], target)
}
function restore(name) {
  const source = join(BACKUP, name)
  if (!existsSync(source)) return false
  mkdirSync(dirname(FILES[name]), { recursive: true })
  copyFileSync(source, FILES[name])
  return true
}

function current() {
  const members = usableMembers(read(MEMBERS))
  const seed = usableText(read(SEED))
  const code = usableText(read(CODE))
  return { members, seed, code }
}

function prepare() {
  const now = current()
  // 1) 先把当前可用数据备份成“上次的好状态”。
  if (now.members) backup('members.json')
  if (now.seed) backup('seed.json')
  if (now.code) backup('teacher-setup-code.txt')
  // 2) 再处理被删/被清空的情况：从备份恢复。
  if (!now.members && existsSync(join(BACKUP, 'members.json'))) {
    const saved = usableMembers(read(join(BACKUP, 'members.json')))
    if (saved && restore('members.json')) console.log(`提醒：成员名单被删除或清空，已从上次备份恢复 ${saved.length} 人（旧邀请仍然有效）。`)
  }
  if ((!now.seed || !now.code) && existsSync(join(BACKUP, 'seed.json')) && existsSync(join(BACKUP, 'teacher-setup-code.txt'))) {
    const seed = usableText(read(join(BACKUP, 'seed.json'))), code = usableText(read(join(BACKUP, 'teacher-setup-code.txt')))
    if (seed && code) {
      const a = restore('seed.json'), b = restore('teacher-setup-code.txt')
      if (a && b) console.log('提醒：一次性口令种子被删除或清空，已从上次备份恢复（旧口令仍然有效）。')
    }
  }
}

function count(text) { const list = usableMembers(text); return list ? list.length : 0 }
function check(expectedMembers, expectedSeed, expectedCode) {
  const now = current()
  let bad = false
  const before = expectedMembers === '' ? 0 : Number(expectedMembers)
  if (Number.isFinite(before) && before > 0 && count(read(MEMBERS)) < before) {
    if (!restore('members.json')) { console.error(`错误：成员名单从 ${before} 人变少，且没有备份可恢复。`); process.exit(1) }
    bad = true
    console.log(`提醒：成员名单变少（更新前 ${before} 人），已从备份恢复。`)
  }
  const seedOk = expectedSeed === '' || !expectedSeed || sha(read(SEED) ?? '') === expectedSeed
  const codeOk = expectedCode === '' || !expectedCode || sha(read(CODE) ?? '') === expectedCode
  if (!seedOk || !codeOk) {
    const a = restore('seed.json'), b = restore('teacher-setup-code.txt')
    if (!a || !b) { console.error('错误：一次性口令种子变了，且没有备份可恢复。请立刻用新口令登记老师，并重新发邀请。'); process.exit(1) }
    bad = true
    console.log('提醒：一次性口令种子变了，已从备份恢复（旧口令仍然有效）。')
  }
  const after = now.members ? now.members.length : count(read(MEMBERS))
  if (bad) process.exit(1)
  console.log(`核对通过：成员名单 ${after} 人、一次性口令没有变。`)
}

const [mode, ...args] = process.argv.slice(2)
if (mode === 'prepare') prepare()
else if (mode === 'check') check(args[0] ?? '', args[1] ?? '', args[2] ?? '')
else { console.error('用法：node scripts/safeguard-data.mjs prepare|check'); process.exit(2) }
