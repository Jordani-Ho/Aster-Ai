import { describe, expect, it } from 'vitest'
import { emptyVisitOrganization, validateVisitOrganization, mergeVisitOrganization } from './visit-organization'

const originals = [{ id:1, text:'合成原话一', source:'spoken' as const }, { id:2, text:'合成原话二', source:'spoken' as const }]
describe('面诊整理依据', () => {
  it('只接受六栏，非空内容必须引用存在且不重复的原话序号', () => {
    const valid = emptyVisitOrganization()
    valid.chiefComplaint = { text:'合成主诉', citations:[1] }
    valid.pulse = { text:'合成脉象', citations:[2] }
    expect(validateVisitOrganization(valid, originals)).toEqual(valid)
    for (const invalid of [
      { ...valid, pulse:{text:'合成', citations:[]} },
      { ...valid, pulse:{text:'合成', citations:[3]} },
      { ...valid, pulse:{text:'合成', citations:[2,2]} },
      { ...valid, pulse:{text:null, citations:[1]} },
      { ...valid, extra:{text:'合成', citations:[1]} },
    ]) expect(validateVisitOrganization(invalid, originals)).toBeNull()
  })
  it('新一段不覆盖老师修改的栏，保留旧依据并追加新段', () => {
    const prior = emptyVisitOrganization(), next = emptyVisitOrganization()
    prior.pulse = {text:'老师手改', citations:[1]}
    prior.ask = {text:'先前记录', citations:[1]}
    next.pulse = {text:'新整理', citations:[2]}
    next.ask = {text:'追加', citations:[2]}
    const merged = mergeVisitOrganization(prior, next, ['pulse'])
    expect(merged.pulse).toEqual(prior.pulse)
    expect(merged.ask).toEqual({text:'先前记录\n追加', citations:[1,2]})
  })
})
