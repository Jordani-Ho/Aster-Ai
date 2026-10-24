import providers from './providers.json'
import probe from '../../../../prompts/model-connection.md?raw'
import {createLlmClient, type LlmClient, type ChatMessage, type ChatOptions} from './index'
import {nip98Authorization} from './nip98'
import type {LocalStore, StoreValue} from '../store'
export {providers}
export interface PersonalModel {provider:string; baseUrl:string; model:string; apiKey:string; testedAt:string}
export interface ModelGateway {baseUrl:string; secretKey:Uint8Array}
export class ModelRequestError extends Error {constructor(public status:number){super('模型连接未完成')}}
// V2-28：建馆第 1 步要能分清“密钥不对 / 账户没额度 / 网络不通”，各说一句怎么办；不带上游原文。
export function connectionError(error:unknown):string {
 const status=error instanceof ModelRequestError?error.status:0
 if(status===401||status===403)return '密钥不对：请到服务商后台重新复制 API Key（注意不要带空格），或确认这个 Key 有权限。'
 if(status===402||status===429)return '账户没额度：请到服务商后台充值，或看看套餐用量是不是用完了。'
 if(status===400||status===404)return '地址或模型名不对：核对接口地址和模型名称后再试。'
 if(status>=500)return '服务商暂时没有响应：等一会儿再试。'
 return '网络不通：检查网络后重试；手机上可以换个 Wi-Fi 或流量再试。'
}
export function normalizeModel(value:unknown):PersonalModel {
 const c=value as PersonalModel
 if(!c||!providers.some(p=>p.id===c.provider)||typeof c.apiKey!=='string'||!c.apiKey.trim()||c.apiKey.length>4096||/[\r\n]/.test(c.apiKey)||typeof c.model!=='string'||!c.model.trim()||c.model.length>200)throw new ModelRequestError(400)
 const url=new URL(c.baseUrl)
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new ModelRequestError(400)
 return {provider:c.provider,baseUrl:url.href.replace(/\/+$/,''),model:c.model.trim(),apiKey:c.apiKey.trim(),testedAt:typeof c.testedAt==='string'?c.testedAt:''}
}
export async function loadPersonalModel(store:LocalStore):Promise<PersonalModel|null>{
 const value=await store.get('settings','personal-model')
 try{const c=normalizeModel(value);return c.testedAt&&Number.isFinite(Date.parse(c.testedAt))?c:null}catch{return null}
}
export async function savePersonalModel(store:LocalStore,config:PersonalModel){await store.put('settings','personal-model',normalizeModel(config) as unknown as StoreValue)}
function ownClient(config:PersonalModel,gateway:ModelGateway|null,timeoutMs:number):LlmClient {
 const c=normalizeModel(config)
 return createLlmClient({kind:'api-key',...c},async(_source,body)=>{
  let response:Response
  const signal=AbortSignal.timeout(timeoutMs)
  const url=c.baseUrl+'/chat/completions'
  try{response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+c.apiKey},body,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal})}
  catch(error){
   // Browsers intentionally cannot distinguish CORS from DNS/TLS/network failures.
   if(!(error instanceof TypeError)||!gateway?.baseUrl)throw error
   const proxyUrl=gateway.baseUrl.replace(/\/+$/,'')+'/proxy',payload=JSON.stringify({url,apiKey:c.apiKey,body})
   response=await fetch(proxyUrl,{method:'POST',headers:{'content-type':'application/json',authorization:await nip98Authorization(gateway.secretKey,proxyUrl,'POST',payload)},body:payload,credentials:'omit',redirect:'error',signal})
  }
  if(!response.ok){void response.body?.cancel();throw new ModelRequestError(response.status)}
  return response
 })
}
// This path deliberately has no house fallback: only the user's own account can unlock home.
export async function testConnection(config:PersonalModel,gateway:ModelGateway|null):Promise<void>{
 const text=await ownClient(config,gateway,10000).complete([{role:'user',content:probe.trim()}])
 if(!text.trim())throw new ModelRequestError(502)
}
// V2-28：社区网关模型（部署方配置的上游账户）单独成一个客户端：只用网关、不带 model、不需要用户自己的 Key。
export function createGatewayClient(gateway:ModelGateway,timeoutMs=10000):LlmClient {
 return createLlmClient({kind:'gateway',...gateway},async(source,body)=>{
  const url=source.baseUrl.replace(/\/+$/,'')+'/chat/completions'
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:await nip98Authorization(gateway.secretKey,url,'POST',body)},body,signal:AbortSignal.timeout(timeoutMs),credentials:'omit',redirect:'error'})
  if(!response.ok){void response.body?.cancel();throw new ModelRequestError(response.status)}return response
 })
}
export function createPersonalClient(config:PersonalModel,gateway:ModelGateway|null,onFallback?:(active:boolean)=>void,timeoutMs=10000):LlmClient {
 const own=ownClient(config,gateway,timeoutMs)
 const house=gateway?.baseUrl?createGatewayClient(gateway,timeoutMs):null
 async function run(messages:ChatMessage[],onToken:((token:string)=>void)|undefined,options?:ChatOptions){
  let emitted=false
  const token=(text:string)=>{emitted=true;onToken?.(text)}
  try{const reply=onToken?await own.stream(messages,token,options):await own.complete(messages,options);if(!reply.trim())throw new ModelRequestError(502);onFallback?.(false);return reply}
  catch(error){if(emitted||!house)throw error;const reply=onToken?await house.stream(messages,token,options):await house.complete(messages,options);onFallback?.(true);return reply}
 }
 return {complete:(m,o)=>run(m,undefined,o),stream:(m,t,o)=>run(m,t,o)}
}
