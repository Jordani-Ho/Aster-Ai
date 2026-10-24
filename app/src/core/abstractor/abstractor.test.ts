import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { classifyVisionFailure, extractTongueJson, readTongue, type TransientPhoto } from './index'
import { parseTongueFeatures, tongueSvg } from '../../../../domain/tcm/tongue'
import { createVisionClient, VisionHttpError, VisionUnsupported } from '../llm/vision'
import { isTongueFailure, TONGUE_FAILURE_MESSAGES } from '../tongue/failures'

const features = { color: 'pale', coatingColor: 'white', coatingThickness: 'thin', shape: 'wide', teeth: ['left-middle', 'right-middle'], cracks: ['center'], confidence: 0.7 }
const box = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }
const context = { shichen: '辰', jieqi: '霜降', city: '合成城' }
// Fixed-path synthetic tongue raster; no person or medical photograph.
const PNG = readFileSync(new URL('./fixtures/tongue.png', import.meta.url)).toString('base64')
function photo(): TransientPhoto { return { bytes: Uint8Array.from(atob(PNG), c => c.charCodeAt(0)), type: 'image/png' } }
const reply = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...features, box, lightingNote: false, ...patch })
const config = { provider: 'qwen', baseUrl: 'https://synthetic.example/v1', model: 'qwen3-vl-plus', apiKey: 'SYNTHETIC_KEY', testedAt: '2026-10-18' }
const NO_TONGUE = TONGUE_FAILURE_MESSAGES.no_tongue
const UNAVAILABLE = TONGUE_FAILURE_MESSAGES.model_unavailable
afterEach(() => vi.unstubAllGlobals())

it('synthetic image -> features + tongue box + lighting note; original bytes stay for cropping, model copy cleared', async () => {
  const input = photo(), original = input.bytes!
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.cache).toBe('no-store'); expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe(config.model)
    expect(body.messages[1].content[0].image_url.url).toBe('data:image/png;base64,' + PNG)
    return new Response(JSON.stringify({ choices: [{ message: { content: reply({ lightingNote: true }) } }] }))
  }); vi.stubGlobal('fetch', fetch)
  const reading = await readTongue(input, context, createVisionClient(config))
  // 原图由调用方在裁剪后清零；读图这一步不能把它清掉，也不能留存副本。
  expect(input.bytes).toBe(original); expect(original.some(byte => byte !== 0)).toBe(true)
  expect(reading).toEqual({ features: parseTongueFeatures(features), box, lightingNote: true })
})

it('tolerates ```json fences, surrounding prose, 0-1000 boxes and extra fields', async () => {
  const fenced = '```json\n' + reply() + '\n```'
  await expect(readTongue(photo(), context, { describe: async () => fenced })).resolves.toMatchObject({ box })
  await expect(readTongue(photo(), context, { describe: async () => '这是结果：' + reply() })).resolves.toMatchObject({ box })
  const scaled = { x: 200, y: 200, width: 600, height: 600 }
  const reading = await readTongue(photo(), context, { describe: async () => reply({ box: scaled, extra: 'ignored', notes: ['x'] }) })
  expect(reading.box).toEqual(box)
})

it.each([
  ['throw', () => { throw Error(PNG) }, UNAVAILABLE],
  ['bad-json', () => PNG, UNAVAILABLE],
  ['html', () => '<html>unavailable</html>', UNAVAILABLE],
  ['invalid-enum', () => reply({ color: 'diagnosis' }), NO_TONGUE],
  ['no-tongue', () => JSON.stringify({ error: 'no_tongue' }), NO_TONGUE],
  ['empty-object', () => '{}', NO_TONGUE],
])('failure %s maps to a typed tongue failure without model content in the error', async (_mode, describe, expected) => {
  const input = photo(), bytes = input.bytes!; let captured: unknown
  const client = { async describe(messages: unknown) { captured = messages; return describe() } }
  let error: unknown
  try { await readTongue(input, context, client) } catch (cause) { error = cause }
  expect(isTongueFailure(error)).toBe(true)
  expect((error as Error).message).toBe(expected)
  expect(input.bytes).toBe(bytes)
  expect(JSON.stringify(captured)).not.toContain(PNG)
})

it('known text-only model refuses before sending', async () => {
  const input = photo(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  let error: unknown
  try { await readTongue(input, context, createVisionClient({ ...config, model: 'qwen-turbo' })) } catch (cause) { error = cause }
  expect(isTongueFailure(error)).toBe(true)
  expect((error as Error).message).toBe(TONGUE_FAILURE_MESSAGES.model_unsupported)
  expect(fetch).not.toHaveBeenCalled()
})

it('HTTP image rejection requests vision model; account vs temporary failures are distinct; no fallback request', async () => {
  const expectations: Record<number, string> = {
    400: TONGUE_FAILURE_MESSAGES.model_unsupported,
    401: TONGUE_FAILURE_MESSAGES.model_account,
    429: TONGUE_FAILURE_MESSAGES.model_account,
    500: TONGUE_FAILURE_MESSAGES.model_unavailable,
  }
  for (const [status, message] of Object.entries(expectations)) {
    const fetch = vi.fn(async () => new Response(PNG, { status: Number(status) })); vi.stubGlobal('fetch', fetch)
    let error: unknown
    try { await readTongue(photo(), context, createVisionClient(config)) } catch (cause) { error = cause }
    expect((error as Error).message).toBe(message)
    expect(fetch).toHaveBeenCalledTimes(1)
  }
})

it('classifies retryable network/timeout/5xx vs non-retryable account and format failures', () => {
  expect(classifyVisionFailure(new VisionHttpError(500)).retryable).toBe(true)
  expect(classifyVisionFailure(new VisionHttpError(503)).retryable).toBe(true)
  expect(classifyVisionFailure(new TypeError('Failed to fetch')).retryable).toBe(true)
  const timeout = new DOMException('timeout', 'TimeoutError')
  expect(classifyVisionFailure(timeout).retryable).toBe(true)
  expect(classifyVisionFailure(new VisionHttpError(401)).kind).toBe('model_account')
  expect(classifyVisionFailure(new VisionHttpError(402)).kind).toBe('model_account')
  expect(classifyVisionFailure(new VisionHttpError(429)).kind).toBe('model_account')
  expect(classifyVisionFailure(new VisionHttpError(401)).retryable).toBe(false)
  expect(classifyVisionFailure(new VisionUnsupported()).kind).toBe('model_unsupported')
})

it('extractTongueJson strips fences and prose, rejects pure garbage', () => {
  expect(extractTongueJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  expect(extractTongueJson('说明{"a":1}完')).toEqual({ a: 1 })
  for (const bad of ['', '纯乱码', '<html></html>', '```json\n{broken}\n```']) {
    let error: unknown
    try { extractTongueJson(bad) } catch (cause) { error = cause }
    expect(isTongueFailure(error)).toBe(true)
    expect((error as Error).message).toBe(UNAVAILABLE)
  }
})

it('SVG is deterministic, order-independent, uses fixed paths/palette only; uncertain is not normal', () => {
  const svg = tongueSvg(features)
  expect(svg).toBe(tongueSvg({ ...features, teeth: [...features.teeth].reverse() }))
  expect(svg).toContain('<svg'); expect(svg).not.toMatch(/<image|href=|script|data:|foreignObject/)
  expect(tongueSvg({ ...features, color: 'uncertain', shape: 'uncertain' })).toContain('待定')
  expect(tongueSvg({ ...features, coatingColor: 'uncertain' })).toContain('stroke-dasharray')
  expect(() => tongueSvg({ ...features, color: '<script>' })).toThrow()
})

it('validates confidence, positions, duplicate marks and missing observations instead of guessing', () => {
  for (const patch of [{ confidence: 1.1 }, { confidence: null }, { teeth: ['center'] }, { cracks: ['center', 'center'] }, { shape: undefined }]) expect(() => parseTongueFeatures({ ...features, ...patch })).toThrow()
  expect(parseTongueFeatures({ ...features, teeth: null, cracks: null }).teeth).toBeNull()
  expect(parseTongueFeatures({ ...features, teeth: 'uncertain', cracks: 'uncertain' }).teeth).toBe('uncertain')
})

it('bad image/context rejected without a model request', async () => {
  const client = { describe: vi.fn() }
  await expect(readTongue({ bytes: null, type: 'image/jpeg' }, context, client)).rejects.toThrow()
  await expect(readTongue(photo(), { ...context, city: 'data:image/png;base64,' + PNG }, client)).rejects.toThrow()
  expect(client.describe).not.toHaveBeenCalled()
})

it('request timeout is bounded, even when provider never responds', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))))
  vi.stubGlobal('fetch', fetch)
  await expect(readTongue(photo(), context, createVisionClient(config, 10))).rejects.toThrow(UNAVAILABLE)
  expect(fetch).toHaveBeenCalledTimes(1)
})
