import { describe, expect, it } from 'vitest'
import { validateOrganizedIntake, type IntakeOriginal } from './organization'

const originals: IntakeOriginal[] = [
  { id: 1, text: '呢排瞓得唔好，成日醒。', source: 'spoken' },
  { id: 2, text: '没有。', source: 'followup' },
]

describe('V2-26 citation-based organization', () => {
  it('allows concise wording when the organized field cites original lines', () => {
    const value = validateOrganizedIntake({
      chiefComplaint: { text: '近期睡眠不佳，易醒', citations: [1] },
      presentIllness: { text: null, citations: [] },
      history: { text: null, citations: [] },
      medsAllergies: { text: null, citations: [] },
    }, originals)
    expect(value?.chiefComplaint.text).toBe('近期睡眠不佳，易醒')
    expect(value?.chiefComplaint.citations).toEqual([1])
  })

  it('rejects a populated field without evidence or with a citation to a missing line', () => {
    const base = {
      chiefComplaint: { text: null, citations: [] }, presentIllness: { text: null, citations: [] },
      history: { text: null, citations: [] }, medsAllergies: { text: null, citations: [] },
    }
    expect(validateOrganizedIntake({ ...base, chiefComplaint: { text: '近期睡眠不佳', citations: [] } }, originals)).toBeNull()
    expect(validateOrganizedIntake({ ...base, chiefComplaint: { text: '近期睡眠不佳', citations: [3] } }, originals)).toBeNull()
  })

  it('rejects citations on empty fields and malformed duplicate citations', () => {
    const base = {
      chiefComplaint: { text: null, citations: [] }, presentIllness: { text: null, citations: [] },
      history: { text: null, citations: [] }, medsAllergies: { text: null, citations: [] },
    }
    expect(validateOrganizedIntake({ ...base, history: { text: null, citations: [1] } }, originals)).toBeNull()
    expect(validateOrganizedIntake({ ...base, history: { text: '没有病史', citations: [2, 2] } }, originals)).toBeNull()
  })
})
