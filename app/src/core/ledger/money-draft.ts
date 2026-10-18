import type { LlmClient } from '../llm'
import prompt from '../../../../prompts/teacher/money-entry.md?raw'
import { currencyCode, toMinor, type MoneyDraft } from './money'
import { EVENT_TYPES, type ChainEventDraft } from './types'
export async function draftMoney(llm:LlmClient,text:string,target:{teacher:string;student:string;currency:string;alias?:string;members?:string[]}):Promise<MoneyDraft> {
 currencyCode(target.currency)
 if(!text.trim()||text.length>2000)throw Error('请说清楚收了多少、送了多少或扣了多少')
 try {
  const data=JSON.parse(await llm.complete([{role:'system',content:prompt},{role:'user',content:JSON.stringify({text,student:target.alias??'当前选定学生',currency:target.currency,members:target.members??[]})}]))
  if(!data||Object.keys(data).join(',')!=='events'||!Array.isArray(data.events)||data.events.length===0||data.events.length>8)throw Error()
  const events:ChainEventDraft[]=data.events.map((event:Record<string,unknown>)=>{
   if(!event||Object.keys(event).some(k=>!['type','amount','forMember','refundFor'].includes(k))||!EVENT_TYPES.includes(event.type as never)||typeof event.amount!=='string')throw Error()
   if(event.forMember!==undefined&&(typeof event.forMember!=='string'||!target.members?.includes(event.forMember)))throw Error()
   if(event.refundFor!==undefined&&(event.type!=='refund'||typeof event.refundFor!=='string'||!/^[a-f0-9]{64}$/.test(event.refundFor)))throw Error()
   return {type:event.type as ChainEventDraft['type'],amount:toMinor(event.amount,target.currency),currency:target.currency,...(event.type==='charge'?{chargeReason:'other' as const}:{}),...(event.forMember?{forMember:event.forMember as string}:{}),...(event.refundFor?{refundFor:event.refundFor as string}:{})}
  })
  return {id:crypto.randomUUID(),teacher:target.teacher,student:target.student,currency:target.currency,events}
 } catch {throw Error('这句话还没能整理成明确的钱账，请重试或把金额与对象说清楚')}
}
