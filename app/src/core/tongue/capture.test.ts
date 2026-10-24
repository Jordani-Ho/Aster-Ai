import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureTongue } from './index'
import { TONGUE_FAILURE_MESSAGES, TONGUE_TOO_FAR_MESSAGE, isTongueFailure } from './failures'
import type { PhotoCodec, TongueCropCodec } from '../intake/photo'
import { VisionHttpError, type VisionClient } from '../llm/vision'
import type { TongueFeatures } from '../../../../domain/tcm/tongue'

// 全部合成：假图片编解码、假视觉模型；不读真实照片、不连网关。
const FEATURES: TongueFeatures = { color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.7 }
const CONTEXT = { shichen: '辰', jieqi: '寒露', city: '合成城' }
const CROP_BYTES = new Uint8Array([9, 9, 9])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
const closer: (() => void)[] = []
afterEach(() => { while (closer.length) closer.pop()!() })

function fakePhotoCodec(source: { width: number; height: number }) {
  const state = { types: [] as string[], draws: [] as { width: number; height: number }[], lastEncoded: null as Uint8Array | null }
  const codec: PhotoCodec = {
    async decode(_bytes, type) { state.types.push(type); return { source: {}, width: source.width, height: source.height } },
    draw(_source, width, height) {
      state.draws.push({ width, height })
      return {
        async toJpeg() { const bytes = JPEG.slice(); state.lastEncoded = bytes; return bytes },
      }
    },
  }
  return { codec, state }
}

function fakeCropCodec(size: { width: number; height: number }) {
  const codec: TongueCropCodec = {
    async decode() { return { source: {}, width: size.width, height: size.height } },
    crop() { return { toJpeg: async () => CROP_BYTES.slice() } },
  }
  return codec
}

function model(box: { x: number; y: number; width: number; height: number }, describe = vi.fn()): VisionClient {
  if (!describe.getMockImplementation()) describe.mockResolvedValue(JSON.stringify({ ...FEATURES, box, lightingNote: false }))
  return { describe }
}

function options(source: { width: number; height: number }, box: Parameters<typeof model>[0], describe = vi.fn()) {
  const photo = fakePhotoCodec(source)
  return { photo, model: model(box, describe), options: { photoCodec: photo.codec, codec: fakeCropCodec(source), noModelRetry: false } }
}

describe('V2-20 送模型前规范化：类型与大图', () => {
  it.each(['image/jpeg', 'image/jpg', 'IMAGE/JPEG', ''])('type %s 不再被前置拒绝，统一重编码成 JPEG 再送模型', async type => {
    const { photo, model: vision, options: opts } = options({ width: 1200, height: 1600 }, { x: 0.3, y: 0.42, width: 0.4, height: 0.26 })
    const input = { bytes: new Uint8Array([1, 2, 3]), type }
    const { record } = await captureTongue(input, CONTEXT, vision, opts)
    expect(record.crop).toBeDefined()
    expect(photo.state.types[0]).toBe(type || 'image/jpeg')
    expect(input.bytes).toBeNull()
  })

  it('长边 6000 的图先缩到 1600 再送模型', async () => {
    const { photo, model: vision, options: opts } = options({ width: 4000, height: 6000 }, { x: 0.3, y: 0.42, width: 0.4, height: 0.26 })
    await captureTongue({ bytes: new Uint8Array([1]), type: 'image/jpeg' }, CONTEXT, vision, opts)
    expect(photo.state.draws).toEqual([{ width: 1067, height: 1600 }])
  })

  it('送出的模型请求是 JPEG（data:image/jpeg）且原图/临时副本都用完清零', async () => {
    const { photo, options: opts } = options({ width: 1200, height: 1600 }, { x: 0.3, y: 0.42, width: 0.4, height: 0.26 })
    let request = ''
    const describe = vi.fn(async (messages: unknown) => {
      request = JSON.stringify(messages)
      return JSON.stringify({ ...FEATURES, box: { x: 0.3, y: 0.42, width: 0.4, height: 0.26 }, lightingNote: false })
    })
    await captureTongue({ bytes: new Uint8Array([7, 7]), type: 'image/jpg' }, CONTEXT, { describe }, opts)
    expect(request).toContain('data:image/jpeg;base64,')
    expect(photo.state.lastEncoded?.every(byte => byte === 0)).toBe(true)
  })

  it('浏览器解不开的 HEIC 等格式：抛“照片格式打不开”，不调模型', async () => {
    const failing: PhotoCodec = {
      async decode() { throw new Error('The source image could not be decoded.') },
      draw() { throw new Error('unreachable') },
    }
    const describe = vi.fn()
    const input = { bytes: new Uint8Array([0, 1, 2]), type: 'image/heic' }
    let error: unknown
    try { await captureTongue(input, CONTEXT, { describe }, { photoCodec: failing }) } catch (cause) { error = cause }
    expect(isTongueFailure(error)).toBe(true)
    expect((error as Error).message).toBe(TONGUE_FAILURE_MESSAGES.photo_format)
    expect(describe).not.toHaveBeenCalled()
    expect(input.bytes).toBeNull()
  })
})

describe('V2-20 门槛：裁剪后短边 ≥160 像素（不再看面积）', () => {
  it('1600×1600 图、舌头占 1%（160×160）→ 通过；面积不再参与判定', async () => {
    const { model: vision, options: opts } = options({ width: 1600, height: 1600 }, { x: 0.45, y: 0.45, width: 0.10, height: 0.10 })
    const { record } = await captureTongue({ bytes: new Uint8Array([1]), type: 'image/jpeg' }, CONTEXT, vision, opts)
    expect(record.crop?.bytes).toBe(CROP_BYTES.length)
  })

  it('同样 1% 面积但短边 100 → 提示靠近，不生成记录', async () => {
    const { model: vision, options: opts } = options({ width: 1600, height: 1600 }, { x: 0.45, y: 0.42, width: 0.0625, height: 0.16 })
    let error: unknown
    try { await captureTongue({ bytes: new Uint8Array([1]), type: 'image/jpeg' }, CONTEXT, vision, opts) } catch (cause) { error = cause }
    expect(isTongueFailure(error)).toBe(true)
    expect((error as Error).message).toBe(TONGUE_TOO_FAR_MESSAGE)
  })
})

describe('V2-20 模型失败分档与自动重试', () => {
  it('网络错误一次后成功：自动重试一次，用户无感', async () => {
    const describe = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(JSON.stringify({ ...FEATURES, box: { x: 0.3, y: 0.42, width: 0.4, height: 0.26 }, lightingNote: false }))
    const { options: opts } = options({ width: 1200, height: 1600 }, { x: 0.3, y: 0.42, width: 0.4, height: 0.26 }, describe)
    const { record } = await captureTongue({ bytes: new Uint8Array([1]), type: 'image/jpeg' }, CONTEXT, { describe }, opts)
    expect(describe).toHaveBeenCalledTimes(2)
    expect(record.crop).toBeDefined()
  })

  it('连续网络失败：重试一次后抛“稍后再拍”', async () => {
    const describe = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const { options: opts } = options({ width: 1200, height: 1600 }, { x: 0.3, y: 0.42, width: 0.4, height: 0.26 }, describe)
    let error: unknown
    try { await captureTongue({ bytes: new Uint8Array([1]), type: 'image/jpeg' }, CONTEXT, { describe }, opts) } catch (cause) { error = cause }
    expect(describe).toHaveBeenCalledTimes(2)
    expect((error as Error).message).toBe(TONGUE_FAILURE_MESSAGES.model_unavailable)
  })

  it('401 账户问题：不重试，提示检查模型账户', async () => {
    const describe = vi.fn().mockRejectedValue(new VisionHttpError(401))
    const { options: opts } = options({ width: 1200, height: 1600 }, { x: 0.3, y: 0.42, width: 0.4, height: 0.26 }, describe)
    let error: unknown
    try { await captureTongue({ bytes: new Uint8Array([1]), type: 'image/jpeg' }, CONTEXT, { describe }, opts) } catch (cause) { error = cause }
    expect(describe).toHaveBeenCalledTimes(1)
    expect((error as Error).message).toBe(TONGUE_FAILURE_MESSAGES.model_account)
  })

  it('模型回复带 ```json 围栏、0–1000 框、多余字段：都能解析出记录', async () => {
    const box = { x: 300, y: 420, width: 400, height: 260 }
    const describe = vi.fn().mockResolvedValue('```json\n' + JSON.stringify({ ...FEATURES, box, extra: true, lightingNote: false }) + '\n```')
    const { options: opts } = options({ width: 1200, height: 1600 }, { x: 0.3, y: 0.42, width: 0.4, height: 0.26 }, describe)
    const { record } = await captureTongue({ bytes: new Uint8Array([1]), type: 'image/jpeg' }, CONTEXT, { describe }, opts)
    expect(record.crop).toBeDefined()
  })
})
