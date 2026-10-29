import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from './core/identity'
import { openStore } from './core/store'
import { loadStudentBasics, sortByBasics, applyStudentBasics } from './student-basics-display'
import { startInPersonEncounter } from './core/record/in-person'

describe('老师端学生基础信息', () => {
  it('只把有效且已进馆的资料视为齐全，排在未完成之前，并以最新城市投影到病历', async () => {
    const identity=createIdentity(), store=await openStore(identity,{factory:new IDBFactory()}), a='a'.repeat(64), b='b'.repeat(64), c='c'.repeat(64)
    try {
      await store.put('teacher-students',a,{student:a,city:'上海市',cityUpdatedAt:20})
      await store.put('teacher-students',b,{student:b})
      await store.put('teacher-student-basics',a,{alias:'合成小明',gender:'other',age:30,bazi:null,city:'北京市',at:10})
      await store.put('teacher-student-basics',c,{alias:'合成未进馆',gender:'other',age:30,bazi:null,city:'北京市',at:10})
      const ready=await loadStudentBasics(store,a), waiting=await loadStudentBasics(store,b)
      expect(ready).toMatchObject({alias:'合成小明',city:'上海市'});expect(waiting).toBeNull();expect(await loadStudentBasics(store,c)).toBeNull()
      await store.put('teacher-student-basics',b,{alias:'',gender:'other',age:30,bazi:null,city:'北京市',at:10})
      expect(await loadStudentBasics(store,b)).toBeNull()
      expect(sortByBasics([{student:b,basics:waiting},{student:a,basics:ready}]).map(x=>x.student)).toEqual([a,b])
      await store.put('teacher-students',a,{student:a,city:'\n',cityUpdatedAt:30})
      expect((await loadStudentBasics(store,a))?.city).toBe('北京市')
      const draft=startInPersonEncounter({teacher:identity.publicKey,student:a})
      expect(applyStudentBasics(draft,ready!).profile.alias.value).toBe('合成小明')
    } finally {store.close();identity.privateKey.fill(0)}
  })
})
