import { describe, expect, it } from 'vitest'
import redFlags from '../../domain/tcm/red-flags.json'

// 守护 domain/tcm/red-flags.json 的基本结构（技术白皮书 §5.4）。
describe('急症红线清单', () => {
  it('每一类都有唯一 id、名称和至少一个关键词', () => {
    const ids = redFlags.categories.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of redFlags.categories) {
      expect(c.id).toMatch(/^RF-\d{2}$/)
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.keywords.length).toBeGreaterThan(0)
    }
  })

  it('覆盖白皮书 §5.4 要求的六类', () => {
    expect(redFlags.categories.length).toBeGreaterThanOrEqual(6)
  })

  it('未核实的号码会被标记出来', () => {
    for (const contact of Object.values(redFlags.contacts)) {
      if (typeof contact === 'string') continue
      expect(typeof contact.verified).toBe('boolean')
    }
  })
})
