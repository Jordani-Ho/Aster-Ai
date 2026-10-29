import prompt from '../../../../prompts/teacher/organize-visit.md?raw'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import type { LlmClient } from '../llm'
import type { IntakeOriginal } from '../record/types'
import { validOriginals } from './organization'
import { fallbackSplit, EXAM_KEYS } from '../../four-exams'
import { emptyVisitOrganization, validateVisitOrganization, VISIT_ORGANIZATION_KEYS, type VisitOrganization } from '../record/visit-organization'

/** 退回原句，保留序号，绝不凭空填主诉或现病史。 */
export function fallbackVisitOrganization(originals: readonly IntakeOriginal[]): VisitOrganization {
  const result=emptyVisitOrganization()
  for (const original of originals) {
    const parts=fallbackSplit(original.text)
    for (const key of EXAM_KEYS) if(parts[key].length) {
      const field=result[key]
      if(field.citations.length >= 100) continue
      field.text=[field.text,...parts[key]].filter(Boolean).join('\n').slice(0,2000)
      if(!field.citations.includes(original.id)) field.citations.push(original.id)
    }
  }
  return result
}
export async function organizeVisit(llm: LlmClient | null | undefined, originals: readonly IntakeOriginal[], template: TeacherTemplate): Promise<{organized:VisitOrganization;usedModel:boolean}> {
  if (!validOriginals(originals)) throw new Error('面诊原话格式无效')
  const fallback=fallbackVisitOrganization(originals)
  if (!llm || !originals.length) return {organized:fallback,usedModel:false}
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const reply=await Promise.race([
      llm.complete([{role:'system',content:prompt},{role:'user',content:JSON.stringify({originals,template:template.workflow?.record ?? {recordOrder:template.recordOrder}})}]),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('整理超时')),30000)}),
    ])
    const parsed:unknown=JSON.parse(reply)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('整理格式无效')
    const organized=validateVisitOrganization((parsed as Record<string,unknown>).organized,originals)
    return organized ? {organized,usedModel:true} : {organized:fallback,usedModel:false}
  } catch { return {organized:fallback,usedModel:false} }
  finally { if(timer!==undefined)clearTimeout(timer) }
}

/** 每次只整理新增的原话，模型的相对序号映射回本次面诊的完整序号。 */
export async function organizeVisitSegment(llm:LlmClient|null|undefined, originals:readonly IntakeOriginal[], after:number, template:TeacherTemplate):Promise<{organized:VisitOrganization;usedModel:boolean}> {
  if (!validOriginals(originals) || !Number.isSafeInteger(after) || after < 0 || after > originals.length) throw Error('面诊原话序号无效')
  const segment=originals.slice(after).map((line,index)=>({...line,id:index+1}))
  const result=await organizeVisit(llm,segment,template)
  for(const key of VISIT_ORGANIZATION_KEYS) result.organized[key].citations=result.organized[key].citations.map(id=>id+after)
  if(!validateVisitOrganization(result.organized,originals)) throw Error('整理依据无效')
  return result
}
