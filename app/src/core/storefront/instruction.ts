import type { LlmClient } from '../llm'
import { normalizeStorefront, STOREFRONT_THEMES, sameStorefront, type Storefront, type StorefrontEmblem, type StorefrontTheme } from './index'

// V2-09：老师一句话改门面。先认常见说法（改名、换色、换标志、改介绍/欢迎语），
// 认不出又接入了模型时，让模型只回一份六项配置 JSON；模型失败就保留原样，不猜。
export type StorefrontChangeSource = 'rule' | 'model'

export interface StorefrontChange {
  storefront: Storefront
  changed: boolean
  source: StorefrontChangeSource
}

const THEME_WORDS: { match: RegExp; theme: StorefrontTheme }[] = [
  { match: /深蓝|蓝色|蓝/, theme: 'cool' },
  { match: /深绿|绿色|暖白|绿/, theme: 'warm' },
  { match: /米色|棕色|棕/, theme: 'sand' },
]

const EMBLEM_WORDS: { match: RegExp; emblem: StorefrontEmblem }[] = [
  { match: /叶子|叶形|绿叶/, emblem: 'leaf' },
  { match: /太阳|日形/, emblem: 'sun' },
  { match: /心形|爱心/, emblem: 'heart' },
  { match: /圆点/, emblem: 'dot' },
]

function tidy(value: string): string {
  return value.trim().replace(/^[“”"'「」『』\s]+|[“”"'「」『』\s]+$/g, '').trim()
}

function capture(instruction: string, pattern: RegExp): string | null {
  const found = instruction.match(pattern)
  if (!found) return null
  const value = tidy(found[1] ?? '')
  return value === '' ? null : value
}

/** 只按常见说法认：认不出返回原配置（changed=false），交给模型或让老师直接改。 */
export function parseStorefrontInstruction(current: Storefront, instruction: string): Storefront {
  const text = typeof instruction === 'string' ? instruction.trim() : ''
  if (text === '') return current
  const next: Storefront = { ...current }
  const name = capture(text, /馆名(?:改成|改为|换成|叫|改称|改做)\s*[:：]?\s*([^，。；,;]+)/)
  if (name) next.name = name.slice(0, 20)
  const displayName = capture(text, /(?:显示称呼|我的称呼|称呼)(?:改成|改为|换成)\s*[:：]?\s*([^，。；,;]+)/)
  if (displayName) next.displayName = displayName.slice(0, 20)
  for (const word of THEME_WORDS) if (word.match.test(text)) { next.theme = word.theme; break }
  for (const word of EMBLEM_WORDS) if (word.match.test(text)) { next.emblem = word.emblem; break }
  const intro = capture(text, /(?:短介绍|介绍|简介)(?:改成|改为|换成)\s*[:：]?\s*([^，。；;]+)/)
  if (intro) next.intro = intro.slice(0, 120)
  const welcome = capture(text, /欢迎语(?:改成|改为|换成)\s*[:：]?\s*([^，。；;]+)/)
  if (welcome) next.welcome = welcome.slice(0, 40)
  return normalizeStorefront(next) ?? current
}

const MODEL_SYSTEM = [
  '你是老师的门面助理，只修改馆名、显示称呼、标志、主题、短介绍、欢迎语这六项外观配置。',
  '不得改动任何健康内容、草稿/已签状态、钱账或币种，也不要写疗效承诺。',
  '标志只能是 leaf / sun / heart / dot / 空字符串；主题只能是 warm / cool / sand。',
  '馆名与显示称呼不超过 20 字，短介绍不超过 120 字，欢迎语不超过 40 字。',
  '只输出一份 JSON 对象，六项齐全，不要解释，不要代码块。',
].join('')

function modelInstruction(current: Storefront, instruction: string): string {
  return JSON.stringify({
    current,
    instruction,
    themes: Object.fromEntries(Object.entries(STOREFRONT_THEMES).map(([id, style]) => [id, style.label])),
  })
}

function parseModelReply(reply: string): Storefront | null {
  const text = typeof reply === 'string' ? reply : ''
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return normalizeStorefront(JSON.parse(text.slice(start, end + 1))) } catch { return null }
}

/** 一句话改门面：规则能认就按规则；认不出且接入了模型时再请模型只改配置。 */
export async function reviseStorefront(options: {
  current: Storefront
  instruction: string
  llm?: LlmClient | null
  complete?: (messages: { role: 'system' | 'user' | 'assistant'; content: string }[]) => Promise<string>
}): Promise<StorefrontChange> {
  const { current, instruction } = options
  const ruled = parseStorefrontInstruction(current, instruction)
  if (!sameStorefront(ruled, current)) return { storefront: ruled, changed: true, source: 'rule' }
  const complete = options.complete ?? (options.llm ? (messages) => options.llm!.complete(messages, { temperature: 0 }) : null)
  if (!complete) return { storefront: current, changed: false, source: 'rule' }
  try {
    const reply = await complete([
      { role: 'system', content: MODEL_SYSTEM },
      { role: 'user', content: modelInstruction(current, instruction) },
    ])
    const model = parseModelReply(reply)
    if (!model || sameStorefront(model, current)) return { storefront: current, changed: false, source: 'model' }
    return { storefront: model, changed: true, source: 'model' }
  } catch {
    // 模型失败保留老师已做的草稿，不改动配置。
    return { storefront: current, changed: false, source: 'model' }
  }
}
