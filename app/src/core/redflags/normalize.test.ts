import { describe, expect, it } from 'vitest'
import redFlagDocument from '../../../../domain/tcm/red-flags.json'
import { COVERED_SIMPLIFIED, normalizeText, TRADITIONAL_TO_SIMPLIFIED } from './normalize'

describe('繁简对照覆盖率', () => {
  it('清单里每个汉字都在覆盖清单里（新增汉字会在这里失败）', () => {
    const chars = new Set<string>()
    for (const category of redFlagDocument.categories) {
      const words = [
        ...category.keywords,
        ...((category as { aggravators?: string[] }).aggravators ?? []),
        ...((category as { durationWords?: string[] }).durationWords ?? []),
      ]
      for (const word of words) for (const char of word) if (/\p{Script=Han}/u.test(char)) chars.add(char)
    }
    const missing = [...chars].filter(char => !COVERED_SIMPLIFIED.includes(char))
    expect(missing, '这些新字需要补进 normalize.ts 的覆盖清单，并按需补繁简对照').toEqual([])
  })

  it('对照表每一项都是单字且确实不同', () => {
    for (const [traditional, simplified] of Object.entries(TRADITIONAL_TO_SIMPLIFIED)) {
      expect(traditional).toMatch(/^\p{Script=Han}$/u)
      expect(simplified).toMatch(/^\p{Script=Han}$/u)
      expect(traditional).not.toBe(simplified)
    }
  })

  it('常见繁体片段能转成简体并去掉空白', () => {
    expect(normalizeText('頭痛欲裂')).toBe('头痛欲裂')
    expect(normalizeText('說話不清楚，嘴歪了')).toBe('说话不清楚，嘴歪了')
    expect(normalizeText('活著沒意思')).toBe('活着没意思')
    expect(normalizeText('胸 口 悶')).toBe('胸口闷')
    expect(normalizeText('覺得自己是個負擔')).toBe('觉得自己是个负担')
  })
})
