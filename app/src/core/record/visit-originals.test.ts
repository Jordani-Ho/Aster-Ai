import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { appendVisitOriginal, editVisitOriginal, loadVisitOriginals } from './visit-originals'

describe('面诊逐句原话', () => {
  it('原话保留原样、顺序编号，老师改错字后保留编辑标记', async () => {
    const store = await openStore(createIdentity(), { factory: new IDBFactory() }), id = 'a'.repeat(32)
    try {
      expect(await appendVisitOriginal(store, id, '  合成原话一  ')).toMatchObject({ id:1, text:'  合成原话一  ' })
      expect(await appendVisitOriginal(store, id, '合成原话二')).toMatchObject({ id:2 })
      await editVisitOriginal(store, id, 1, '老师改正')
      expect(await loadVisitOriginals(store, id)).toEqual([{ id:1, text:'老师改正', source:'spoken', edited:true }, { id:2, text:'合成原话二', source:'spoken', edited:false }])
    } finally { store.close() }
  })
  it('拒绝无效病历、空句、超长句和不存在的序号', async () => {
    const store = await openStore(createIdentity(), { factory: new IDBFactory() }), id = 'a'.repeat(32)
    try {
      for (const [key, text] of [['bad','合成'], [id,' '], [id,'长'.repeat(2001)]]) await expect(appendVisitOriginal(store,key,text)).rejects.toThrow()
      await expect(editVisitOriginal(store,id,1,'合成')).rejects.toThrow()
    } finally { store.close() }
  })
})
