import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import rules from '../../../../domain/tcm/kangbi-rules.json'
import { calculateKangbi } from '../../../../domain/tcm/kangbi'
import { recordObservation, kangbiSummary } from './index'
const observation={id:'synthetic-1',student:'a'.repeat(64),teacher:'b'.repeat(64),at:'2026-10-18T12:00:00Z',practiceDays:1,teacherMinutes:15,consultations:1,effects:{teacher:1,self:1,measurement:1}}
const fixture={weights:{teacher:0.5,self:0.3,measurement:0.2},kePerPracticeDay:2,declinePerUnit:1,kePerConsultation:1,minutesPerKe:15,dailyCap:10}
it('生产规则所有数值留 null，持续记录观察数据但不产生事件或余额',async()=>{
 const leaves=(v:unknown):unknown[]=>v&&typeof v==='object'?Object.values(v).flatMap(leaves):[v]
 expect(leaves(rules).every(v=>v===null)).toBe(true)
 expect(calculateKangbi(observation,rules)).toBeNull()
 const store=await openStore(createIdentity(),{factory:new IDBFactory(),name:crypto.randomUUID()})
 try {
  await recordObservation(store,observation);await recordObservation(store,observation)
  expect(await store.list('kangbi-events')).toEqual([])
  const summary=await kangbiSummary(store)
  expect(summary.observations).toBe(1);expect(summary.teacherMinutes).toBe(15)
  expect(JSON.stringify(summary)).not.toMatch(/aaaaaa|bbbbbb|student|teacherKey/)
 } finally {store.close()}
})
it('仅用测试专用规则验证时间×效果、零效果、下降、流向和日上限，改配置即可改变结果',()=>{
 expect(calculateKangbi(observation,fixture)?.create).toBe(2)
 expect(calculateKangbi(observation,{...fixture,kePerPracticeDay:4})?.create).toBe(4)
 expect(calculateKangbi({...observation,effects:{teacher:0,self:0,measurement:0}},fixture)?.create).toBe(0)
 expect(calculateKangbi({...observation,effects:{teacher:-1,self:-1,measurement:-1}},fixture)?.decline).toBe(1)
 expect(calculateKangbi(observation,fixture,10)?.create).toBe(0)
 expect(calculateKangbi(observation,fixture)?.flow).toBe(1)
})
