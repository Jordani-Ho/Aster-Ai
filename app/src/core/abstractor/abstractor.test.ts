import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { readTongue, type TransientPhoto } from './index'
import { parseTongueFeatures, tongueSvg, TONGUE_RETAKE } from '../../../../domain/tcm/tongue'
import { createVisionClient } from '../llm/vision'

const features = { color: 'pale', coatingColor: 'white', coatingThickness: 'thin', shape: 'wide', teeth: ['left-middle', 'right-middle'], cracks: ['center'], confidence: 0.7 }
const box = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }
const context = { shichen: '辰', jieqi: '霜降', city: '合成城' }
// Fixed-path synthetic tongue raster; no person or medical photograph.
const PNG = readFileSync(new URL('./fixtures/tongue.png', import.meta.url)).toString('base64')
function photo(): TransientPhoto { return { bytes: Uint8Array.from(atob(PNG), c => c.charCodeAt(0)), type: 'image/png' } }
const reply = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...features, box, lightingNote: false, ...patch })
const config = { provider: 'qwen', baseUrl: 'https://synthetic.example/v1', model: 'qwen3-vl-plus', apiKey: 'SYNTHETIC_KEY', testedAt: '2026-10-18' }
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

it.each(['throw', 'bad-json', 'invalid-enum', 'no-tongue', 'tiny-box'])('failure %s requests retake, with no model content in error', async mode => {
  const input = photo(), bytes = input.bytes!; let captured: any
  const client = {
    async describe(messages: any) {
      captured = messages
      if (mode === 'throw') throw Error(PNG)
      if (mode === 'bad-json') return PNG
      if (mode === 'invalid-enum') return reply({ color: 'diagnosis' })
      if (mode === 'no-tongue') return JSON.stringify({ error: 'no_tongue' })
      return reply({ box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } })
    },
  }
  const expected = mode === 'throw' || mode === 'bad-json' ? '这次没看清，请重新拍一张' : TONGUE_RETAKE
  await expect(readTongue(input, context, client)).rejects.toThrow(expected)
  expect(input.bytes).toBe(bytes)
  expect(JSON.stringify(captured)).not.toContain(PNG)
})

it('known text-only model refuses before sending', async () => {
  const input = photo(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  await expect(readTongue(input, context, createVisionClient({ ...config, model: 'qwen-turbo' }))).rejects.toThrow('请换用支持看图的模型')
  expect(fetch).not.toHaveBeenCalled()
})

it('HTTP image rejection requests vision model, other errors request retake; no fallback request', async () => {
  for (const status of [400, 401, 429, 500]) {
    const fetch = vi.fn(async () => new Response(PNG, { status })); vi.stubGlobal('fetch', fetch)
    await expect(readTongue(photo(), context, createVisionClient(config))).rejects.toThrow(status === 400 ? '请换用支持看图的模型' : '这次没看清，请重新拍一张')
    expect(fetch).toHaveBeenCalledTimes(1)
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
  const client = { describe: vi.fn() }; const input = photo()
  await expect(readTongue(input, { ...context, city: 'data:image/png;base64,' + PNG }, client)).rejects.toThrow()
  expect(client.describe).not.toHaveBeenCalled()
})

it('request timeout is bounded, even when provider never responds', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))))
  vi.stubGlobal('fetch', fetch)
  await expect(readTongue(photo(), context, createVisionClient(config, 10))).rejects.toThrow('这次没看清，请重新拍一张')
  expect(fetch).toHaveBeenCalledTimes(1)
})
