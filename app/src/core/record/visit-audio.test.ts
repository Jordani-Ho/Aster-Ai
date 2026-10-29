import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { appendVisitAudioChunk, loadVisitAudio, clearVisitAudio } from './visit-audio'

describe('面诊录音本机保存', () => {
  it('分块按录音顺序保存、恢复和删除，其他病历不受影响', async () => {
    const store = await openStore(createIdentity(), { factory:new IDBFactory() }), id='a'.repeat(32), other='b'.repeat(32)
    try {
      await appendVisitAudioChunk(store,id,'segment-1','audio/webm',new Uint8Array([1,2]))
      await appendVisitAudioChunk(store,id,'segment-1','audio/webm',new Uint8Array([3]))
      await appendVisitAudioChunk(store,other,'segment-1','audio/webm',new Uint8Array([9]))
      const value=await loadVisitAudio(store,id,'segment-1')
      expect(value?.mimeType).toBe('audio/webm'); expect(value?.data).toEqual(new Uint8Array([1,2,3]))
      await clearVisitAudio(store,id)
      expect(await loadVisitAudio(store,id,'segment-1')).toBeNull(); expect((await loadVisitAudio(store,other,'segment-1'))?.data).toEqual(new Uint8Array([9]))
    } finally { store.close() }
  })
  it('拒绝无效病历、空数据和变更格式', async () => {
    const store=await openStore(createIdentity(),{factory:new IDBFactory()}), id='a'.repeat(32)
    try {
      await expect(appendVisitAudioChunk(store,'bad','segment-1','audio/webm',new Uint8Array([1]))).rejects.toThrow()
      await expect(appendVisitAudioChunk(store,id,'segment-1','audio/webm',new Uint8Array())).rejects.toThrow()
      await appendVisitAudioChunk(store,id,'segment-1','audio/webm',new Uint8Array([1]))
      await expect(appendVisitAudioChunk(store,id,'segment-1','audio/ogg',new Uint8Array([1]))).rejects.toThrow()
    } finally { store.close() }
  })
})
