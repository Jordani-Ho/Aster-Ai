// 急症红线“只增不减”检查（技术白皮书 §5.4，AGENTS.md 铁律 3）。
// 用法：node scripts/check-red-flags.mjs <基准分支，默认 origin/main>
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const base = process.argv[2] ?? 'origin/main'
const file = 'domain/tcm/red-flags.json'
const current = JSON.parse(readFileSync(file, 'utf8'))

let previous
try {
  previous = JSON.parse(execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
} catch {
  console.log(`基准 ${base} 上还没有 ${file}，跳过检查。`)
  process.exit(0)
}

const ids = (doc) => new Map(doc.categories.map((c) => [c.id, c]))
const now = ids(current)
const errors = []
for (const [id, old] of ids(previous)) {
  const cur = now.get(id)
  if (!cur) { errors.push(`删除了红线类别 ${id}（${old.name}）`); continue }
  for (const kw of old.keywords) {
    if (!cur.keywords.includes(kw)) errors.push(`${id} 删除了关键词「${kw}」`)
  }
}
if (errors.length) {
  console.error('急症红线只能增加，不能删除（C 类决策，须经发起人确认）：')
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}
console.log('急症红线检查通过。')
