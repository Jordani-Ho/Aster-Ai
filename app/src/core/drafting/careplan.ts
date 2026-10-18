import prompt from '../../../../prompts/teacher/draft-careplan.md?raw'
import type { LlmClient } from '../llm'
import type { CarePlanDraft } from '../careplan/issue'
export async function draftCarePlan(instruction: string, llm: LlmClient, timeoutMs = 30000): Promise<CarePlanDraft> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (!instruction.trim() || instruction.length > 2000) throw Error()
    const text = await Promise.race([
      llm.complete([{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ instruction }) }]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error()), timeoutMs) }),
    ])
    const value = JSON.parse(text)
    const words = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 500
    const items = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10 && v.every(words)
    if (!value || !words(value.constitution) || !items(value.points) || !items(value.avoid)) throw Error()
    return { constitution: value.constitution, points: value.points, avoid: value.avoid, source: 'ai_draft' }
  } catch { throw Error('方案起草未完成，请重试；尚未签发。') }
  finally { if (timer) clearTimeout(timer) }
}
