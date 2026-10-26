import prompt from '../../../../prompts/teacher/organize-intake.md?raw'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import type { LlmClient } from '../llm'
import type { IntakeOriginal, OrganizedIntake } from '../record/types'
import { rawOrganization, validateOrganizedIntake, validOriginals } from './organization'

/** 老师模型只看原话与老师模板，不接收音频字节。坏回复退回原句结构，签字仍由真人完成。 */
export async function organizeForTeacher(
  llm: LlmClient | null | undefined,
  originals: readonly IntakeOriginal[] | undefined,
  template: TeacherTemplate,
): Promise<OrganizedIntake | null> {
  if (!llm || !originals || !validOriginals(originals) || originals.length === 0) return null
  try {
    const reply = await llm.complete([
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify({ originals, template: template.workflow?.record ?? { recordOrder: template.recordOrder } }) },
    ])
    const parsed: unknown = JSON.parse(reply)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    const organized = validateOrganizedIntake((parsed as Record<string, unknown>).organized, originals)
    return organized ?? rawOrganization(originals)
  } catch {
    return rawOrganization(originals)
  }
}
