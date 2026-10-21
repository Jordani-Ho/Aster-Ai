import { useEffect, useRef, useState } from 'react'
import type { LocalStore } from './core/store'
import type { LlmClient } from './core/llm'
import type { Ledger } from './core/ledger'
import { parseChainFields } from './core/ledger'
import { confirmMoney, currencyCode, formatMoney, saveMoneyCurrency, type MoneyDraft, type MoneyWriter } from './core/ledger/money'
import { draftMoney } from './core/ledger/money-draft'
const labels={topup:'充值',gift:'赠送钱',charge:'扣费',refund:'退款'}
interface PendingDraft {id:string;alias:string;currency:string;text:string;requestedAt:string}
export function MoneyEntry({store,book,writer,llm,onConfirmed}:{store:LocalStore;book:Ledger;writer:MoneyWriter;llm:LlmClient|null;onConfirmed:()=>void}) {
 const [alias,setAlias]=useState(''),[currency,setCurrency]=useState(''),[text,setText]=useState(''),[draft,setDraft]=useState<MoneyDraft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const lock=useRef(false),active=useRef(true)
 const pending=useRef<PendingDraft|null>(null)
 const [loaded,setLoaded]=useState(false)
 useEffect(()=>{active.current=true;void(async()=>{
  const name=await store.get('money-alias',book.student)
  if(typeof name==='string'&&active.current)setAlias(name)
  const code=book.events.length?parseChainFields(book.events[0]).currency:await store.get('settings','money-currency')
  if(typeof code==='string'&&active.current){try{setCurrency(currencyCode(code))}catch{}}
  const job=await store.get('money-drafts',book.student) as any
  if(job&&job.teacher===book.teacher&&job.student===book.student&&active.current){setAlias(job.alias);setCurrency(job.currency);setText(job.text);if(job.draft){setDraft(job.draft)}else{pending.current=job;void generate(job)}}
 })().catch(()=>{if(active.current)setError('钱账设置读取失败，请重试')}).finally(()=>{if(active.current)setLoaded(true)})
 const retry=()=>{if(pending.current)void generate(pending.current)}
 window.addEventListener('online',retry);window.addEventListener('focus',retry)
 return()=>{active.current=false;window.removeEventListener('online',retry);window.removeEventListener('focus',retry)}},[store,book.student,llm])
 const generate=async(resume?:PendingDraft)=>{
  if(lock.current||!llm)return
  lock.current=true;setBusy(true);setError('');setDraft(null);setNotice('')
  try {
   const job=resume??{id:crypto.randomUUID(),alias:alias.trim(),currency,text,requestedAt:new Date().toISOString()}
   currencyCode(job.currency)
   if(!job.alias||job.alias.length>30)throw Error('请先给这本钱账填一个能认出的学生称呼')
   await store.put('money-alias',book.student,job.alias);await saveMoneyCurrency(store,job.currency)
   await store.put('money-drafts',book.student,{...job,teacher:book.teacher,student:book.student})
   pending.current=job
   const members=[...new Set(book.events.map(e=>parseChainFields(e).forMember).filter((v):v is string=>!!v))]
   const result=await draftMoney(llm,job.text,{teacher:book.teacher,student:book.student,currency:job.currency,alias:job.alias,members})
   result.id=job.id
   const current=await store.get('money-drafts',book.student) as any
   if(current?.id!==job.id)return
   await store.put('money-drafts',book.student,{...job,teacher:book.teacher,student:book.student,draft:result} as never)
   pending.current=null
   if(active.current)setDraft(result)
  }catch(cause){if(active.current)setError(cause instanceof Error?cause.message:'草稿生成失败，请重试')}
  finally{lock.current=false;if(active.current)setBusy(false)}
 }
 const confirm=async()=>{
  if(!draft||lock.current)return
  lock.current=true;setBusy(true);setError('')
  try {await confirmMoney(writer,draft);await store.delete('money-drafts',book.student);if(active.current){setDraft(null);setText('');setNotice('已记入钱账；离线时恢复连接后补送');onConfirmed()}}
  catch(cause){if(active.current)setError(cause instanceof Error?cause.message:'未能入账，请重试')}
  finally{lock.current=false;if(active.current)setBusy(false)}
 }
 return <section aria-label="老师一句话记钱账">
  <label>这位学生的称呼<input maxLength={30} disabled={busy||!loaded} value={alias} onChange={e=>{setAlias(e.target.value);setDraft(null);pending.current=null;void store.delete('money-drafts',book.student).catch(()=>setError('旧草稿未能清除，请重试'))}}/></label>
  <label>钱账币种<select aria-label="钱账币种" value={currency} disabled={!loaded||busy||book.events.length>0} onChange={e=>{const code=e.target.value;setCurrency(code);setDraft(null);pending.current=null;void store.delete('money-drafts',book.student).then(()=>code?store.put('settings','money-currency',currencyCode(code)):undefined).catch(()=>setError('币种未能保存，请重试'))}}><option value="">按老师所在地选择</option>{Intl.supportedValuesOf('currency').map(code=><option key={code} value={code}>{code}</option>)}</select></label>
  <label>说一句话记账<textarea disabled={busy||!loaded} value={text} maxLength={2000} placeholder="收到小王 100，送 20" onChange={e=>{setText(e.target.value);setDraft(null);pending.current=null;void store.delete('money-drafts',book.student).catch(()=>setError('旧草稿未能清除，请重试'))}}/></label>
  <button disabled={!loaded||busy||!llm||!text.trim()||!currency||!alias.trim()} onClick={()=>void generate()}>生成记账草稿</button>
  {!llm&&<p>请先接入模型；模型只生成草稿。</p>}
  {draft&&<article aria-label="钱账确认草稿"><p>给 {alias} · {draft.currency}</p><ol>{draft.events.map((event,index)=><li key={index}>{labels[event.type]} {formatMoney(event.amount!,draft.currency)}{event.forMember?' · '+event.forMember:''}</li>)}</ol><p>核对后才入账。</p><button disabled={busy} onClick={()=>void confirm()}>确认入账</button><button disabled={busy} onClick={()=>{setDraft(null);pending.current=null;void store.delete('money-drafts',book.student).catch(()=>setError('取消草稿未能保存，请重试'))}}>取消草稿</button></article>}
  {error&&pending.current&&<p>原话已保存在本机；连接恢复或回到页面会重试，仍需本人确认才入账。</p>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </section>
}
