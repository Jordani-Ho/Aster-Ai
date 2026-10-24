import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type LocalStore } from '../store'
import {
  isTongueFailure, listTongueFailures, recordTongueFailure, TONGUE_FAILURE_MAX_ROWS,
  TONGUE_FAILURE_MESSAGES, TONGUE_TOO_FAR_MESSAGE, tongueFailure, tongueFailureKind, TONGUE_FAILURES,
} from './failures'
import { tongueCropMinShortSide } from '../../../../domain/tcm/tongue'

const closers: LocalStore[] = []
afterEach(() => { while (closers.length) closers.pop()!.close() })
async function newStore(): Promise<LocalStore> {
  const store = await openStore(createIdentity(), { factory: new IDBFactory(), name: crypto.randomUUID() })
  closers.push(store)
  return store
}

describe('V2-20 失败分档：四档文案与本机类别记录', () => {
  it('四档各一句话；太远与没拍到同属一档但提示更具体', () => {
    expect(TONGUE_FAILURE_MESSAGES.photo_format).toBe('这张照片的格式手机浏览器打不开，请用相机直接拍，或在相机设置里选“兼容性最佳”。')
    expect(TONGUE_FAILURE_MESSAGES.no_tongue).toBe('没拍到舌头，请靠近一点再拍')
    expect(TONGUE_FAILURE_MESSAGES.model_unavailable).toContain('稍后再拍')
    expect(TONGUE_FAILURE_MESSAGES.model_account).toBe('看舌象的模型账户需要检查（额度或密钥）')
    expect(TONGUE_TOO_FAR_MESSAGE).toContain('靠近一点再拍')
    const failure = tongueFailure('no_tongue', TONGUE_TOO_FAR_MESSAGE)
    expect(isTongueFailure(failure)).toBe(true)
    expect(tongueFailureKind(failure)).toBe('no_tongue')
    expect(tongueFailureKind(Error('x'))).toBeNull()
  })

  it('network/5xx 标成可重试；账户、格式、没拍到不重试', () => {
    expect(tongueFailure('model_unavailable', undefined, true).retryable).toBe(true)
    for (const kind of ['photo_format', 'no_tongue', 'model_account', 'model_unsupported'] as const) {
      expect(tongueFailure(kind).retryable).toBe(false)
    }
  })

  it('只记类别与时间，不存照片或模型原文；超过 100 条只留最近 100 条', async () => {
    const store = await newStore()
    const start = Date.parse('2026-10-23T00:00:00Z')
    for (let index = 0; index < 105; index++) {
      await recordTongueFailure(store, index % 2 === 0 ? 'model_account' : 'no_tongue', new Date(start + index * 1000))
    }
    const rows = await listTongueFailures(store)
    expect(rows).toHaveLength(TONGUE_FAILURE_MAX_ROWS)
    expect(rows[0].at > '2026-10-23T00:00:04Z').toBe(true)
    expect(rows.every(row => row.kind === 'model_account' || row.kind === 'no_tongue')).toBe(true)
    expect(rows.every(row => Object.keys(row).sort().join(',') === 'at,id,kind')).toBe(true)
    const dump = JSON.stringify(await store.list(TONGUE_FAILURES))
    expect(dump).not.toContain('data:image')
    expect(dump).not.toContain('base64')
    expect(dump).not.toContain('image_url')
  })

  it('像素门槛放在 domain/tcm/tongue-features.json：短边阈值为正整数 160', () => {
    expect(tongueCropMinShortSide()).toBe(160)
    expect(Number.isSafeInteger(tongueCropMinShortSide())).toBe(true)
  })
})
