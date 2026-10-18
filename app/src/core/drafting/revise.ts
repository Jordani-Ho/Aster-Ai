import prompt from '../../../../prompts/teacher/revise-draft.md?raw'
import type { LlmClient } from '../llm'
import type { Encounter, Field } from '../record/types'
import { prescription, homework } from './index'
const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v)
// 只允许改起草字段；省略保持原值，null 明确清空。身份、原话、附件和签字信息永不接受模型覆盖。
export async function reviseEncounter(input:Encounter, instruction:string, llm:LlmClient, options:{timeoutMs?:number}={}):Promise<Encounter> {
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    if(!instruction.trim()||instruction.length>2000) throw Error()
    const reply=await Promise.race([
      llm.complete([{role:'system',content:prompt},{role:'user',content:JSON.stringify({instruction,draft:{fourExams:input.fourExams,judgment:input.judgment,plan:input.plan,outcome:input.outcome}})}]),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error()),options.timeoutMs??30000)}),
    ])
    const raw:unknown=JSON.parse(reply)
    if(!object(raw))throw Error()
    const result=structuredClone(input)
    let changes=0
    for(const name of ['fourExams','judgment','plan','outcome'] as const){
      if(raw[name]===undefined)continue
      const patch=raw[name], target=result[name]
      if(!object(patch)||!target)throw Error()
      for(const [key,item] of Object.entries(patch)){
        if(!Object.hasOwn(target,key))throw Error()
        if(name==='plan'&&key==='homework'){
          if(!Array.isArray(item))throw Error()
          const parsed=homework(item)
          if(parsed.length!==item.length)throw Error()
          result.plan.homework=parsed;changes++;continue
        }
        if(!object(item)||!Object.hasOwn(item,'value'))throw Error()
        const value=item.value
        if(value!==null && (name==='plan'&&key==='prescription' ? !prescription(value) : typeof value!=='string'||!value.trim()))throw Error()
        ;(target as unknown as Record<string,Field<unknown>>)[key]={value:structuredClone(value),source:'ai_draft'}
        changes++
      }
    }
    if(!changes)throw Error()
    return result
  }catch{throw Error('改稿未完成，原卡片已保留，请重试。')}
  finally{if(timer)clearTimeout(timer)}
}
