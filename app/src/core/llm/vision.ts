import {normalizeModel, type PersonalModel} from './personal'
export type VisionMessage = {role:'system';content:string}|{role:'user';content:{type:'image_url';image_url:{url:string}}[]}
export interface VisionClient {describe(messages:VisionMessage[]):Promise<string>}
export class VisionUnsupported extends Error {constructor(){super('请换用支持看图的模型')}}
// Known text-only identifiers only; unknown/custom endpoint IDs are tried, not guessed capable.
const TEXT_ONLY = /^(?:qwen-turbo|deepseek-chat|deepseek-reasoner|moonshot-v1-\d+k)$/i
export function createVisionClient(config:PersonalModel, timeoutMs=30000):VisionClient {
 return {async describe(messages){
  const c=normalizeModel(config)
  if(TEXT_ONLY.test(c.model))throw new VisionUnsupported()
  let body:string|undefined=JSON.stringify({model:c.model,messages,stream:false})
  let response:Response|undefined
  try {
   // The image goes only to the student's selected provider: no house model or gateway retries.
   response=await fetch(c.baseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+c.apiKey},body,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(timeoutMs)})
   if(response.status===400||response.status===415||response.status===422)throw new VisionUnsupported()
   if(!response.ok)throw Error('视觉请求未完成')
   const data=await response.json() as {choices?:{message?:{content?:unknown}}[]}
   const reply=data.choices?.[0]?.message?.content
   if(typeof reply!=='string'||reply.length>8192)throw Error('视觉回复无效')
   return reply
  } finally {
   body=undefined
   if(response&&!response.bodyUsed)await response.body?.cancel().catch(()=>{})
  }
 }}
}
