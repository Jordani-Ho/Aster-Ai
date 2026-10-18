import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import type { PhotoCodec } from '../intake/photo'
import { listTongueDays, recentTongue, saveTonguePhoto, tongueBytes } from './index'

// 合成 JPEG；V2 起不再做 EXIF 逐段剥离，舌象只经过压缩编码器（真实浏览器 canvas 重编码天然不带原 EXIF）。
function jpegWithExif(fragment: number): Uint8Array {
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x01, 0x02, fragment]
  const length = payload.length + 2
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...payload, 0xff, 0xda, 0x00, 0x00])
}

function codecReturning(bytes: Uint8Array): PhotoCodec {
  return {
    decode: async () => ({ source: {}, width: 100, height: 100 }),
    draw: () => ({ toJpeg: async () => bytes }),
  }
}

describe('舌象日记（验收第 5 条）', () => {
  it('一天拍两张只保留最后一张（压缩后的字节）', async () => {
    const identity = createIdentity()
    const store = await openStore(identity, { factory: new IDBFactory() })
    const now = new Date('2026-10-17T08:00:00.000Z')
    const today = '2026-10-17'

    const first = await saveTonguePhoto(store, { bytes: jpegWithExif(0x11), type: 'image/jpeg' }, { codec: codecReturning(jpegWithExif(0x11)), now: () => now })
    const second = await saveTonguePhoto(store, { bytes: jpegWithExif(0x22), type: 'image/jpeg' }, { codec: codecReturning(jpegWithExif(0x22)), now: () => now })
    expect(first.date).toBe(today)
    expect(second.date).toBe(today)

    // 只有当天一条，且字节是后拍的那张（经压缩编码器输出）
    expect(await listTongueDays(store)).toEqual([today])
    const bytes = await tongueBytes(store, today)
    expect(bytes).not.toBeNull()
    expect(bytes![0]).toBe(0xff)
    expect(bytes![1]).toBe(0xd8)

    // 最近 30 天缩略列表也只含这一张
    const recent = await recentTongue(store, 30, now)
    expect(recent).toHaveLength(1)
    expect(recent[0].date).toBe(today)
    store.close()
  })
})
