import prompt from '../../prompts/teacher/split-exams.md?raw'
import type { LlmClient } from './core/llm'

// V2-16 面诊“您说，智能体记”：把老师口述的一段话拆进望闻问切四格。
// 只做界面层的整理：不写病历定论、不签字；模型失败时退回本地关键词拆分，流程不中断。
export const EXAM_KEYS = ['look', 'listenSmell', 'ask', 'pulse'] as const
export type ExamKey = (typeof EXAM_KEYS)[number]
export type ExamFragments = Record<ExamKey, string[]>

export const EXAM_LABELS: Record<ExamKey, string> = { look: '望', listenSmell: '闻', ask: '问', pulse: '切' }

const MAX_FRAGMENT = 200

export function emptyFragments(): ExamFragments {
  return { look: [], listenSmell: [], ask: [], pulse: [] }
}

const KEYWORDS: Record<ExamKey, readonly string[]> = {
  look: ['舌', '苔', '面', '色', '目', '眼', '唇', '形', '斑', '疹', '肿', '皮肤', '指纹', '淡红', '苍白', '齿痕'],
  listenSmell: ['声', '音', '咳', '喘', '口气', '味', '呼吸', '呃逆', '嗳气', '低微', '嘶哑'],
  pulse: ['脉', '按', '触', '手足', '腹', '温', '凉', '热', '浮', '沉', '细', '弦', '滑', '弱'],
  ask: [],
}

// 断网/无模型时的本地拆分：按标点切成短句，按关键词归到四格；没命中就归“问”。
export function fallbackSplit(text: string): ExamFragments {
  const result = emptyFragments()
  const clauses = text.split(/[。；;\n]+/).map(clause => clause.trim()).filter(Boolean)
  for (const clause of clauses) {
    let key: ExamKey = 'ask'
    for (const candidate of ['look', 'listenSmell', 'pulse'] as const) {
      if (KEYWORDS[candidate].some(word => clause.includes(word))) { key = candidate; break }
    }
    const fragment = clause.slice(0, MAX_FRAGMENT)
    if (!result[key].includes(fragment)) result[key].push(fragment)
  }
  if (clauses.length === 0 && text.trim() !== '') result.ask.push(text.trim().slice(0, MAX_FRAGMENT))
  return result
}

function validFragments(raw: unknown, text: string): string[] {
  if (!Array.isArray(raw)) return []
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const fragment = item.trim()
    if (fragment === '' || fragment.length > MAX_FRAGMENT) continue
    // 只接受原话里出现过的片段，避免模型改写或编造。
    if (!text.includes(fragment)) continue
    if (!result.includes(fragment)) result.push(fragment)
  }
  return result
}

export function validateSplit(raw: unknown, text: string): ExamFragments | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const result = emptyFragments()
  let count = 0
  for (const key of EXAM_KEYS) {
    result[key] = validFragments(source[key], text)
    count += result[key].length
  }
  return count > 0 ? result : null
}

export interface SplitResult {
  fragments: ExamFragments
  usedModel: boolean
}

// 有模型时让模型拆；任何失败（超时、格式错、片段不是原话）都退回本地拆分。
export async function splitFourExams(text: string, llm: LlmClient | null | undefined, options: { timeoutMs?: number } = {}): Promise<SplitResult> {
  const value = text.trim()
  if (value === '') return { fragments: emptyFragments(), usedModel: false }
  const fallback = fallbackSplit(value)
  if (!llm) return { fragments: fallback, usedModel: false }
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { fragments: fallback, usedModel: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const reply = await Promise.race([
      llm.complete([{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ text: value }) }]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs) }),
    ])
    const parsed: unknown = JSON.parse(reply)
    const fragments = validateSplit(parsed, value)
    return fragments ? { fragments, usedModel: true } : { fragments: fallback, usedModel: false }
  } catch {
    return { fragments: fallback, usedModel: false }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
