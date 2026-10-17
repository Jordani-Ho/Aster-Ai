import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import redFlagDocument from '../../../../domain/tcm/red-flags.json'

const checker = fileURLToPath(new URL('../../../../scripts/check-red-flags.mjs', import.meta.url))

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=redflag-test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('git 失败：' + result.stderr)
  return result.stdout
}

function runChecker(cwd: string, base: string) {
  return spawnSync(process.execPath, [checker, base], { cwd, encoding: 'utf8' })
}

// 验收用例 5：删除清单里任何一类，CI 的“只增不减”检查必须失败。
describe('急症红线只增不减检查', () => {
  it('删除任意一类红线都会让检查失败', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aster-redflags-'))
    const file = join(directory, 'domain/tcm/red-flags.json')
    try {
      mkdirSync(join(directory, 'domain/tcm'), { recursive: true })
      writeFileSync(file, JSON.stringify(redFlagDocument, null, 2))
      git(directory, ['init', '-q'])
      git(directory, ['add', '.'])
      git(directory, ['commit', '-q', '-m', 'base'])
      const base = git(directory, ['rev-parse', 'HEAD']).trim()

      const unchanged = runChecker(directory, base)
      expect(unchanged.status, unchanged.stderr).toBe(0)

      for (const category of redFlagDocument.categories) {
        const reduced = { ...redFlagDocument, categories: redFlagDocument.categories.filter(item => item.id !== category.id) }
        writeFileSync(file, JSON.stringify(reduced, null, 2))
        const result = runChecker(directory, base)
        expect(result.status, category.id).toBe(1)
        expect(result.stderr, category.id).toContain('删除了红线类别 ' + category.id)
      }

      const first = redFlagDocument.categories[0]
      const trimmed = {
        ...redFlagDocument,
        categories: redFlagDocument.categories.map(item => item.id === first.id ? { ...item, keywords: item.keywords.slice(1) } : item),
      }
      writeFileSync(file, JSON.stringify(trimmed, null, 2))
      const keywordResult = runChecker(directory, base)
      expect(keywordResult.status, first.id).toBe(1)
      expect(keywordResult.stderr).toContain('删除了关键词')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
