import type { ChainEventDraft, Ledger } from './types'
import { parseChainFields } from './types'
import { verify } from './verify'
import type { LocalStore } from '../store'
export async function moneyCurrencyFor(store:LocalStore,teacher:string,student?:string):Promise<string|null> {
 if(student){for(const row of await store.list('ledger-index')){const ref=row.value as any;if(ref.teacher===teacher&&ref.student===student){const state=await store.get(ref.collection,ref.key) as any;if(!state||state.ledger?.teacher!==teacher||state.ledger?.student!==student||verify(state.ledger).length)throw Error('本机钱账未通过校验');if(state.ledger.events.length)return parseChainFields(state.ledger.events[0]).currency}}}
 const value=await store.get('settings','money-currency')
 return typeof value==='string'?currencyCode(value):null
}
export function currencyCode(currency:string):string {
 if(!Intl.supportedValuesOf('currency').includes(currency))throw Error('请选择有效币种（如 CNY、USD）')
 return currency
}
export function currencyDigits(currency:string):number {
 return new Intl.NumberFormat('en',{style:'currency',currency:currencyCode(currency)}).resolvedOptions().maximumFractionDigits!
}
export function toMinor(text:string,currency:string):number {
 if(!/^(0|[1-9]\d*)(\.\d+)?$/.test(text))throw Error('金额请写普通正数，不要指数或符号')
 const digits=currencyDigits(currency),[whole,part='']=text.split('.')
 if(part.length>digits)throw Error('金额小数位超过该币种的最小单位')
 const value=BigInt(whole)*10n**BigInt(digits)+BigInt(part.padEnd(digits,'0')||'0')
 if(value<=0n||value>BigInt(Number.MAX_SAFE_INTEGER))throw Error('金额必须大于零且不能超出安全范围')
 return Number(value)
}
export function formatMoney(minor:number,currency:string):string {
 if(!Number.isSafeInteger(minor))throw Error('金额超出安全范围')
 const digits=currencyDigits(currency),factor=10n**BigInt(digits),absolute=BigInt(minor<0?-minor:minor),whole=absolute/factor
 const value=minor<0?(whole===0n?-0:-whole):whole
 return new Intl.NumberFormat('zh-CN',{style:'currency',currency:currencyCode(currency),currencyDisplay:'code'}).formatToParts(value).map(part=>part.type==='fraction'?String(absolute%factor).padStart(digits,'0'):part.value).join('')
}
export interface MoneyDraft {id:string;teacher:string;student:string;currency:string;events:ChainEventDraft[]}
export interface MoneyWriter {recordBatch(teacher:string,student:string,drafts:ChainEventDraft[],confirmationId:string):Promise<unknown>}
// 真人确认入口，只使用已解析的草稿；本文件不导入模型。
export async function confirmMoney(writer:MoneyWriter,draft:MoneyDraft):Promise<void> {
 if(!draft||!/^[a-f0-9]{64}$/.test(draft.teacher)||!/^[a-f0-9]{64}$/.test(draft.student)||!Array.isArray(draft.events)||!draft.events.length||draft.events.length>8)throw Error('记账草稿无效')
 currencyCode(draft.currency)
 if(draft.events.some(e=>e.currency!==draft.currency))throw Error('草稿币种不一致')
 await writer.recordBatch(draft.teacher,draft.student,structuredClone(draft.events),draft.id)
}
export function moneySummary(books:readonly Ledger[]) {
 const people=new Set<string>(),byCurrency:Record<string,{balance:number;topup:number;gift:number;charge:number;refund:number}>={}
 for(const book of books){if(verify(book).length)throw Error('账本未通过校验，不能汇总');people.add(book.student);for(const event of book.events){const f=parseChainFields(event),row=byCurrency[f.currency]??={balance:0,topup:0,gift:0,charge:0,refund:0};row[f.type]+=f.amount!;row.balance+=(f.type==='topup'||f.type==='gift'?1:-1)*f.amount!;if(!Object.values(row).every(Number.isSafeInteger))throw Error('汇总金额超出安全范围')}}
 return {participants:people.size,books:books.length,byCurrency}
}
