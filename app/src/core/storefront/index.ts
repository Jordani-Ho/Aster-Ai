import { finalizeEvent, getEventHash, verifyEvent, type Event } from 'nostr-tools/pure'
import type { Identity } from '../identity'
import type { LocalStore, StoreValue } from '../store'
import type { Envelope } from '../transport'

// V2-09 老师门面：一份只含外观的配置，由老师本人签名。学生端只缓存验签通过的最新一版。
// 配置是数据不是代码：这里只有馆名、显示称呼、标志、主题、短介绍、欢迎语六项。
export const STOREFRONT_KIND = 2733
export const STOREFRONT_TYPE = 'storefront.update'
/** 学生端按老师公钥缓存门面事件。 */
export const STOREFRONT_COLLECTION = 'storefront'
/** 老师端自己的当前门面与上一版（只留一版）。 */
export const STOREFRONT_SETTING = 'storefront'
/** 老师正在编辑、还没点“用这个样子”的草稿。 */
export const STOREFRONT_DRAFT_SETTING = 'storefront-draft'
/** 学生当前在用的馆（老师公钥）；切换只改视角，不改收件与数据。 */
export const ACTIVE_TEACHER_SETTING = 'active-teacher'

export const EMBLEMS = ['leaf', 'sun', 'heart', 'dot'] as const
export type StorefrontEmblem = (typeof EMBLEMS)[number] | ''
export const THEMES = ['warm', 'cool', 'sand'] as const
export type StorefrontTheme = (typeof THEMES)[number]

export interface StorefrontThemeStyle {
  label: string
  background: string
  primary: string
}

// 三套现成主题：暖白+深绿、浅灰+深蓝、米色+棕。主题只给门牌、邀请首屏和门面预览上色。
export const STOREFRONT_THEMES: Record<StorefrontTheme, StorefrontThemeStyle> = {
  warm: { label: '暖白 · 深绿', background: '#fbf7ef', primary: '#245a3f' },
  cool: { label: '浅灰 · 深蓝', background: '#f2f4f7', primary: '#1d4f91' },
  sand: { label: '米色 · 棕', background: '#f6efe3', primary: '#7a4a2b' },
}

export interface Storefront {
  /** 馆名，学生看到的门牌。 */
  name: string
  /** 老师自己的显示称呼，例如“阿慈”。 */
  displayName: string
  /** 简单标志，可空。 */
  emblem: StorefrontEmblem
  theme: StorefrontTheme
  /** 短介绍，≤120 字。 */
  intro: string
  /** 欢迎语，≤40 字。 */
  welcome: string
}

export const DEFAULT_STOREFRONT: Storefront = { name: '', displayName: '', emblem: '', theme: 'warm', intro: '', welcome: '' }

export const STOREFRONT_LIMITS = { name: 20, displayName: 20, intro: 120, welcome: 40 } as const

export interface StorefrontEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

const HEX64 = /^[0-9a-f]{64}$/
const CONTROL = /[\u0000-\u001f\u007f]/

function cleanText(value: unknown, max: number, required = false): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (required && text === '') return null
  if (text.length > max || CONTROL.test(text)) return null
  return text
}

/** 只接受这六项、限长、无控制字符；其他字段一律丢掉。 */
export function normalizeStorefront(value: unknown): Storefront | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const name = cleanText(raw.name, STOREFRONT_LIMITS.name)
  const displayName = cleanText(raw.displayName, STOREFRONT_LIMITS.displayName)
  const intro = cleanText(raw.intro, STOREFRONT_LIMITS.intro)
  const welcome = cleanText(raw.welcome, STOREFRONT_LIMITS.welcome)
  if (name === null || displayName === null || intro === null || welcome === null) return null
  const emblem = raw.emblem ?? ''
  if (emblem !== '' && !(EMBLEMS as readonly unknown[]).includes(emblem)) return null
  const theme = raw.theme ?? 'warm'
  if (!(THEMES as readonly unknown[]).includes(theme)) return null
  return { name, displayName, emblem: emblem as StorefrontEmblem, theme: theme as StorefrontTheme, intro, welcome }
}

export function sameStorefront(left: Storefront, right: Storefront): boolean {
  return left.name === right.name && left.displayName === right.displayName && left.emblem === right.emblem
    && left.theme === right.theme && left.intro === right.intro && left.welcome === right.welcome
}

export function themeOf(storefront: Storefront | null | undefined): StorefrontThemeStyle {
  return STOREFRONT_THEMES[storefront?.theme ?? DEFAULT_STOREFRONT.theme]
}

/** 显示称呼 → “某某老师”；已经带“老师”的不重复加。 */
export function displayTeacherName(displayName: string, key?: string): string {
  const value = typeof displayName === 'string' ? displayName.trim() : ''
  if (value !== '') return value.endsWith('老师') ? value : value + '老师'
  return key && HEX64.test(key) ? '老师 ' + key.slice(-6) : '老师'
}

/** 邀请首屏标题：“阿慈老师邀请你”；老师还没配门面时用不带公钥的“老师邀请你”。 */
export function inviteTitle(storefront: Storefront | null | undefined, key?: string): string {
  const displayName = typeof storefront?.displayName === 'string' ? storefront.displayName.trim() : ''
  if (displayName === '') return '老师邀请你'
  return displayTeacherName(displayName, key) + '邀请你'
}

function contentOf(storefront: Storefront, receiveRecordings: boolean): string {
  return JSON.stringify({ type: 'aster.storefront', version: 1, storefront, receiveRecordings })
}

export function makeStorefrontEvent(identity: Identity, storefront: Storefront, now = Math.floor(Date.now() / 1000), receiveRecordings = true): StorefrontEvent {
  const clean = normalizeStorefront(storefront)
  if (!clean) throw new Error('门面配置无效')
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('门面时间无效')
  if (typeof receiveRecordings !== 'boolean') throw new Error('接收录音设置无效')
  const event = finalizeEvent({ kind: STOREFRONT_KIND, created_at: now, tags: [], content: contentOf(clean, receiveRecordings) }, identity.privateKey)
  // JSON 往返去掉 verify 缓存 Symbol，签名事件才能安全落盘/进信封。
  return JSON.parse(JSON.stringify(event)) as StorefrontEvent
}

function eventShape(value: unknown): StorefrontEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !HEX64.test(v.id)) return null
  if (typeof v.pubkey !== 'string' || !HEX64.test(v.pubkey)) return null
  if (typeof v.sig !== 'string' || typeof v.content !== 'string') return null
  if (!Number.isSafeInteger(v.created_at) || v.kind !== STOREFRONT_KIND) return null
  if (!Array.isArray(v.tags) || !v.tags.every(tag => Array.isArray(tag) && tag.every(item => typeof item === 'string'))) return null
  return { id: v.id, pubkey: v.pubkey, created_at: v.created_at as number, kind: STOREFRONT_KIND, tags: v.tags as string[][], content: v.content, sig: v.sig }
}

export interface VerifiedStorefront {
  event: StorefrontEvent
  storefront: Storefront
  receiveRecordings: boolean
}

/** 结构 + 内容 + 签名都通过才算有效；expectedTeacher 给出时还要求签名人就是这位老师。 */
export function verifyStorefrontEvent(value: unknown, expectedTeacher?: string): VerifiedStorefront | null {
  const event = eventShape(value)
  if (!event) return null
  if (expectedTeacher !== undefined && event.pubkey !== expectedTeacher) return null
  let content: unknown
  try { content = JSON.parse(event.content) } catch { return null }
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null
  const fields = content as { type?: unknown; version?: unknown; storefront?: unknown; receiveRecordings?: unknown }
  if (fields.type !== 'aster.storefront' || fields.version !== 1) return null
  if (fields.receiveRecordings !== undefined && typeof fields.receiveRecordings !== 'boolean') return null
  const storefront = normalizeStorefront(fields.storefront)
  if (!storefront) return null
  let idMatches = false
  try { idMatches = getEventHash(event) === event.id } catch { idMatches = false }
  if (!idMatches) return null
  try { if (!verifyEvent(event as Event)) return null } catch { return null }
  return { event, storefront, receiveRecordings: fields.receiveRecordings !== false }
}

// ---- 学生端缓存 ----

async function cachedEvent(store: Pick<LocalStore, 'get'>, teacher: string): Promise<StorefrontEvent | null> {
  if (!HEX64.test(teacher)) return null
  return eventShape(await store.get(STOREFRONT_COLLECTION, teacher))
}

export async function loadCachedStorefront(store: Pick<LocalStore, 'get'>, teacher: string): Promise<Storefront | null> {
  const event = await cachedEvent(store, teacher)
  return event ? verifyStorefrontEvent(event, teacher)?.storefront ?? null : null
}

/** 旧签名门面没有该偏好时按默认值开启。 */
export async function loadCachedReceiveRecordings(store: Pick<LocalStore, 'get'>, teacher: string): Promise<boolean> {
  const event = await cachedEvent(store, teacher)
  return event ? verifyStorefrontEvent(event, teacher)?.receiveRecordings ?? true : true
}

export async function loadCachedStorefronts(store: Pick<LocalStore, 'list'>): Promise<Record<string, Storefront>> {
  const result: Record<string, Storefront> = {}
  for (const row of await store.list(STOREFRONT_COLLECTION)) {
    if (!HEX64.test(row.key)) continue
    const verified = verifyStorefrontEvent(row.value, row.key)
    if (verified) result[row.key] = verified.storefront
  }
  return result
}

/** 时间更旧或同样时间的版本不覆盖已缓存的最新有效版；验签失败直接丢弃。 */
export async function saveReceivedStorefront(store: Pick<LocalStore, 'get' | 'put'>, event: unknown, expectedTeacher?: string): Promise<boolean> {
  const verified = verifyStorefrontEvent(event, expectedTeacher)
  if (!verified) return false
  const prior = await cachedEvent(store, verified.event.pubkey)
  if (prior && prior.created_at >= verified.event.created_at) return false
  await store.put(STOREFRONT_COLLECTION, verified.event.pubkey, verified.event as unknown as StoreValue)
  return true
}

// ---- 老师端自己的门面 ----

export interface OwnStorefront {
  current: StorefrontEvent | null
  previous: StorefrontEvent | null
}

export async function loadOwnStorefront(store: Pick<LocalStore, 'get'>, identity: Identity): Promise<OwnStorefront> {
  const value = await store.get('settings', STOREFRONT_SETTING) as { current?: unknown; previous?: unknown } | undefined
  const current = verifyStorefrontEvent(value?.current, identity.publicKey)?.event ?? null
  const previous = verifyStorefrontEvent(value?.previous, identity.publicKey)?.event ?? null
  return { current, previous }
}

async function saveOwn(store: Pick<LocalStore, 'put'>, own: OwnStorefront): Promise<void> {
  await store.put('settings', STOREFRONT_SETTING, { current: own.current ?? null, previous: own.previous ?? null } as unknown as StoreValue)
}

/** 学生的门面草稿；老师改配置时不立刻生效，点“用这个样子”才签名发布。 */
export async function loadStorefrontDraft(store: Pick<LocalStore, 'get'>): Promise<Storefront | null> {
  return normalizeStorefront(await store.get('settings', STOREFRONT_DRAFT_SETTING))
}

export async function saveStorefrontDraft(store: Pick<LocalStore, 'put'>, storefront: Storefront): Promise<void> {
  const clean = normalizeStorefront(storefront)
  if (!clean) throw new Error('门面配置无效')
  await store.put('settings', STOREFRONT_DRAFT_SETTING, clean as unknown as StoreValue)
}

/** “用这个样子”：签名发布，并把上一版留作“恢复上次样子”。 */
export async function publishStorefront(options: {
  store: Pick<LocalStore, 'get' | 'put'>
  identity: Identity
  storefront: Storefront
  receiveRecordings?: boolean
  now?: Date
}): Promise<{ event: StorefrontEvent; own: OwnStorefront }> {
  const { store, identity } = options
  const clean = normalizeStorefront(options.storefront)
  if (!clean) throw new Error('门面配置无效')
  const own = await loadOwnStorefront(store, identity)
  const priorPreference = own.current ? verifyStorefrontEvent(own.current, identity.publicKey)?.receiveRecordings : undefined
  const preference = options.receiveRecordings ?? priorPreference ?? true
  const event = makeStorefrontEvent(identity, clean, Math.floor((options.now ?? new Date()).getTime() / 1000), preference)
  const next: OwnStorefront = { current: event, previous: own.current }
  await saveOwn(store, next)
  return { event, own: next }
}

/** “恢复上次样子”：把上一版重新签名成当前版本（学生端只认更新的时间），再对调当前/上一版。 */
export async function restoreStorefront(options: {
  store: Pick<LocalStore, 'get' | 'put'>
  identity: Identity
  now?: Date
}): Promise<{ event: StorefrontEvent; storefront: Storefront } | null> {
  const { store, identity } = options
  const own = await loadOwnStorefront(store, identity)
  if (!own.previous) return null
  const previous = verifyStorefrontEvent(own.previous, identity.publicKey)
  const storefront = previous?.storefront
  if (!storefront) return null
  const event = makeStorefrontEvent(identity, storefront, Math.floor((options.now ?? new Date()).getTime() / 1000), previous.receiveRecordings)
  await saveOwn(store, { current: event, previous: own.current })
  return { event, storefront }
}

export function storefrontEnvelope(event: StorefrontEvent): Envelope {
  return { type: STOREFRONT_TYPE, version: 1, payload: { event } }
}

/** 老师把当前门面发给指定学生（一条一条，幂等；没配过门面就什么都不发）。 */
export async function sendStorefrontTo(options: {
  store: Pick<LocalStore, 'get'>
  identity: Identity
  recipients: readonly string[]
  send: (recipient: string, envelope: Envelope) => Promise<unknown>
}): Promise<number> {
  const own = await loadOwnStorefront(options.store, options.identity)
  if (!own.current) return 0
  let sent = 0
  for (const recipient of options.recipients) {
    if (!HEX64.test(recipient) || recipient === options.identity.publicKey) continue
    await options.send(recipient, storefrontEnvelope(own.current))
    sent++
  }
  return sent
}

// ---- 邀请首屏判定 ----

export type InviteWelcome = { kind: 'welcome'; storefront: Storefront | null } | { kind: 'continue' }

/** 新学生（本机还没有这位老师）先看首屏；老学生直接回到原来的使用情境，不重复入门。 */
export function inviteWelcome(teachers: readonly string[], teacher: string, storefront: Storefront | null): InviteWelcome {
  if (!HEX64.test(teacher)) return { kind: 'continue' }
  if (teachers.includes(teacher)) return { kind: 'continue' }
  return { kind: 'welcome', storefront }
}
