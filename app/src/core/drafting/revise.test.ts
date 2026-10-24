import { describe, it, expect, vi } from 'vitest'
import { startInPersonEncounter } from '../record/in-person'
import { acceptDraftForSigning } from '../record/sign'
import { reviseEncounter } from './revise'
import { pendingDraftFields, signEncounter } from '../record/sign'
import { getPublicKey } from 'nostr-tools/pure'
const key = new Uint8Array(32).fill(1)
function draft() {
  const e = startInPersonEncounter({teacher:getPublicKey(key),student:'b'.repeat(64)})
  e.plan.prescription = {value:{items:[{herb:'合成药甲',dose:'1g'},{herb:'合成药乙',dose:'2g'}]},source:'ai_draft'}
  e.plan.homework = [{id:'test',title:'合成作业',detail:'合成要点',schedule:{kind:'daily',time:'20:00'},source:'ai_draft'}]
  e.outcome = {change:{value:'合成变化',source:'ai_draft'},adverse:{value:null,source:'unknown'},next:{value:null,source:'unknown'}}
  return e
}
describe('M1-20 整卡改稿与签字边界',()=>{
  it('按意见改方仍为草稿，模型不能改身份原话或提前确认；点击签字才统一确认，包括作业和复诊字段',async()=>{
    const before=draft(), original=structuredClone(before)
    const llm={complete:vi.fn().mockResolvedValue(JSON.stringify({plan:{prescription:{value:{items:[{herb:'合成药乙',dose:'2g'}]},source:'teacher'}},intake:{chiefComplaint:{value:'篡改'}},teacher:'篡改'})),stream:vi.fn()}
    const revised=await reviseEncounter(before,'去掉合成药甲',llm)
    expect(revised.plan.prescription.value?.items.map(i=>i.herb)).toEqual(['合成药乙'])
    expect(revised.plan.prescription.source).toBe('ai_draft')
    // V2-19：按意见改到的字段带 teacher_directed，签字后仍算老师改过。
    expect(revised.plan.prescription.note).toBe('teacher_directed')
    expect(revised.plan.homework).toEqual(before.plan.homework)
    expect(revised.teacher).toBe(before.teacher);expect(revised.intake).toEqual(before.intake)
    expect(()=>signEncounter(revised,key)).toThrow()
    const final=acceptDraftForSigning(revised)
    expect(pendingDraftFields(final)).toEqual([])
    expect(final.plan.prescription).toMatchObject({source:'teacher',note:'teacher_directed'})
    expect(final.plan.homework[0]).toMatchObject({source:'teacher',note:'ai_accepted'})
    expect(final.outcome?.change.source).toBe('teacher')
    expect(JSON.parse(signEncounter(final,key).content)).toEqual(final)
    expect(before).toEqual(original);expect(revised.plan.prescription.source).toBe('ai_draft')
  })
  it('改稿改到的作业也带 teacher_directed，签字确认时保留',async()=>{
    const llm={complete:vi.fn().mockResolvedValue(JSON.stringify({plan:{homework:[{title:'合成作业',detail:'合成要点',schedule:{kind:'daily',time:'21:00'}}]}})),stream:vi.fn()}
    const revised=await reviseEncounter(draft(),'作业改成每晚九点',llm)
    expect(revised.plan.homework[0]).toMatchObject({source:'ai_draft',note:'teacher_directed'})
    const final=acceptDraftForSigning(revised)
    expect(final.plan.homework[0]).toMatchObject({source:'teacher',note:'teacher_directed'})
  })
  it('格式错误、拒绝、超时不得抹掉原卡片或静默签字',async()=>{
    for(const reply of ['{}','不是JSON',JSON.stringify({plan:{prescription:{value:{items:[]}}}})]) {
      const before=draft(),copy=structuredClone(before)
      await expect(reviseEncounter(before,'改稿',{complete:vi.fn().mockResolvedValue(reply),stream:vi.fn()})).rejects.toThrow('改稿')
      expect(before).toEqual(copy)
    }
    await expect(reviseEncounter(draft(),'改稿',{complete:vi.fn(()=>new Promise<string>(()=>{})),stream:vi.fn()},{timeoutMs:5})).rejects.toThrow('改稿')
  })
})
