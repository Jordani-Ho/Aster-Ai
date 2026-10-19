import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import rules from '../../../../domain/tcm/kangbi-rules.json'
import { calculateKangbi, type HealthObservation } from '../../../../domain/tcm/kangbi'
import { recordObservation, kangbiSummary } from './index'
const observation:HealthObservation={id:'synthetic-1',student:'a'.repeat(64),teacher:'b'.repeat(64),at:'2026-10-18T12:00:00Z',periodStart:'2026-10-11T12:00:00Z',periodEnd:'2026-10-18T12:00:00Z',practiceDays:1,teacherMinutes:15,consultations:1,teacherNote:'improve',agentNote:'unsure',effects:{teacher:1,measurement:1}}
const fixture={weights:{teacher:0.5,measurement:0.5},kePerPracticeDay:2,declinePerUnit:1,kePerConsultation:1,minutesPerKe:15,dailyCap:10}
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
  expect(JSON.stringify(summary)).not.toMatch(/aaaaaa|bbbbbb|student|teacherKey|improve|unsure/)
 } finally {store.close()}
})
it('仅用测试专用规则验证时间×效果、零效果、下降、流向和日上限，改配置即可改变结果',()=>{
 expect(calculateKangbi(observation,fixture)?.create).toBe(2)
 expect(calculateKangbi(observation,{...fixture,kePerPracticeDay:4})?.create).toBe(4)
 expect(calculateKangbi({...observation,effects:{teacher:0,measurement:0}},fixture)?.create).toBe(0)
 expect(calculateKangbi({...observation,effects:{teacher:-1,measurement:-1}},fixture)?.decline).toBe(1)
 expect(calculateKangbi(observation,fixture,10)?.create).toBe(0)
 expect(calculateKangbi(observation,fixture)?.flow).toBe(1)
})
it('老师分钟允许小数（设备计时），天数与次数必须是整数',()=>{
 expect(calculateKangbi({...observation,teacherMinutes:1.75},fixture)).not.toBeNull()
 expect(()=>calculateKangbi({...observation,practiceDays:1.5},fixture)).toThrow()
 expect(()=>calculateKangbi({...observation,consultations:1.5},fixture)).toThrow()
})
it('旧的 V2-04 观察记录（含 self 评分、没有周期与两句话）仍能汇总，读时不重写盘上数据',async()=>{
 const store=await openStore(createIdentity(),{factory:new IDBFactory(),name:crypto.randomUUID()})
 try {
  const legacy={id:'legacy-1',student:'a'.repeat(64),teacher:'b'.repeat(64),at:'2026-10-01T12:00:00Z',practiceDays:2,teacherMinutes:0,consultations:0,effects:{teacher:null,self:3,measurement:null}}
  await store.put('kangbi-observations','legacy-1',legacy)
  const summary=await kangbiSummary(store)
  expect(summary.observations).toBe(1)
  expect(summary.ratings.teacher.count).toBe(0)
  expect(Object.keys(summary.ratings).sort()).toEqual(['measurement','teacher'])
  expect(await store.get('kangbi-observations','legacy-1')).toEqual(legacy)
 } finally {store.close()}
})
