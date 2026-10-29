import { describe, expect, it, vi } from 'vitest'
import { organizeVisit, organizeVisitSegment } from './visit-organizer'
import { emptyVisitOrganization } from '../record/visit-organization'
const originals = [{id:1,text:'合成最近睡不好',source:'spoken' as const},{id:2,text:'合成脉弦细',source:'spoken' as const}]
const template = {id:'synthetic',name:'合成',recordOrder:['主诉'],focus:[],notes:''}
describe('面诊整理模型',()=>{
 it('只把原话和模板交给模型，校验引用与六栏',async()=>{
  const result=emptyVisitOrganization();result.chiefComplaint={text:'睡眠不佳',citations:[1]};result.pulse={text:'脉弦细',citations:[2]}
  const complete=vi.fn(async (_messages: import('../llm').ChatMessage[])=>JSON.stringify({organized:result})), client={complete,stream:async()=>''}
  const got=await organizeVisit(client,originals,template)
  expect(got.usedModel).toBe(true);expect(got.organized).toEqual(result)
  const input=JSON.parse(complete.mock.calls[0][0][1].content);expect(input.originals).toEqual(originals);expect(input.template).toBeDefined()
 })
 it('无依据的模型输出拒绝，退回有原句引用的关键词拆分',async()=>{
  const bad=emptyVisitOrganization();bad.pulse={text:'编造',citations:[99]}
  const got=await organizeVisit({complete:async()=>JSON.stringify({organized:bad}),stream:async()=>''},originals,template)
  expect(got.usedModel).toBe(false);expect(got.organized.pulse.citations).toEqual([2]);expect(got.organized.pulse.text).toContain('合成脉弦细')
 })
 it('第二段的相对序号映射成全程原话序号',async()=>{
  const result=emptyVisitOrganization();result.pulse={text:'合成脉象',citations:[1]}
  const got=await organizeVisitSegment({complete:async()=>JSON.stringify({organized:result}),stream:async()=>''},originals,1,template)
  expect(got.organized.pulse.citations).toEqual([2])
  await expect(organizeVisitSegment(null,originals,3,template)).rejects.toThrow('序号')
 })
})
