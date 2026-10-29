import { describe, expect, it } from 'vitest'
import { processVisitPhoto } from './visit-photo'
import type { PhotoCodec } from '../intake/photo'
function codec(sizes: number[]): PhotoCodec {
  return { decode: async () => ({ source: {}, width: 3200, height: 1600 }), draw: (_source, width, height) => {
    expect([width, height]).toEqual([1600, 800])
    let i = 0
    return { toJpeg: async () => new Uint8Array(sizes[i++] ?? sizes.at(-1)!) }
  } }
}
describe('面诊患处图片边界', () => {
  it('最多三张，逐步压缩至不超过 400 KB', async () => {
    const result = await processVisitPhoto({ bytes: new Uint8Array([1]), type:'image/jpeg' }, { codec: codec([450 * 1024, 399 * 1024]), existingCount:2 })
    expect(result.data.length).toBe(399 * 1024)
    await expect(processVisitPhoto({ bytes:new Uint8Array([1]), type:'image/jpeg' }, { codec:codec([1]), existingCount:3 })).rejects.toThrow('3')
    await expect(processVisitPhoto({ bytes:new Uint8Array([1]), type:'image/jpeg' }, { codec:codec([401 * 1024]), existingCount:0 })).rejects.toThrow('400')
  })
  it('拒绝无效数量和空照片', async () => {
    await expect(processVisitPhoto({ bytes:new Uint8Array([1]), type:'image/jpeg' }, { codec:codec([1]), existingCount:-1 })).rejects.toThrow()
    await expect(processVisitPhoto({ bytes:new Uint8Array(), type:'image/jpeg' }, { codec:codec([1]) })).rejects.toThrow()
  })
})
