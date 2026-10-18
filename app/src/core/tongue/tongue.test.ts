import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import type { PhotoCodec } from '../intake/photo'
import { listTongueDays, recentTongue, saveTonguePhoto, tongueBytes } from './index'

// 合成 JPEG：SOI + APP1(EXIF) + 一个可辨识的字节片段；用于断言保存后不再含 EXIF 段。
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

function hasExif(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i += 1) if (bytes[i] === 0xff && bytes[i + 1] === 0xe1) return true
  return false
}

describe('舌象日记（验收第 5 条）', () => {
  it('一天拍两张只保留最后一张，且保存的 JPEG 无 EXIF', async () => {
    const identity = createIdentity('leader monkey parrot ring guide accident before fence cannon height naive bean', 'english', 3)
    const store = await openStore(identity, { factory: new IDBFactory() })
    const now = new Date('2026-10-17T08:00:00.000Z')
    const today = '2026-10-17'

    const first = await saveTonguePhoto(store, { bytes: jpegWithExif(0x11), type: 'image/jpeg' }, { codec: codecReturning(jpegWithExif(0x11)), now: () => now })
    const second = await saveTonguePhoto(store, { bytes: jpegWithExif(0x22), type: 'image/jpeg' }, { codec: codecReturning(jpegWithExif(0x22)), now: () => now })
    expect(first.date).toBe(today)
    expect(second.date).toBe(today)

    // 只有当天一条，且字节是后拍的那张（去 EXIF 后）
    expect(await listTongueDays(store)).toEqual([today])
    const bytes = await tongueBytes(store, today)
    expect(bytes).not.toBeNull()
    expect(hasExif(bytes!)).toBe(false)

    // 最近 30 天缩略列表也只含这一张
    const recent = await recentTongue(store, 30, now)
    expect(recent).toHaveLength(1)
    expect(recent[0].date).toBe(today)
    store.close()
  })
})
