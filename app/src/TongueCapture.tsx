import { useRef, useState, useEffect } from 'react'
import type { LocalStore } from './core/store'
import { loadPersonalModel } from './core/llm/personal'
import { createVisionClient } from './core/llm/vision'
import { abstractTongue } from './core/abstractor'
import { loadProfile, saveProfile } from './core/intake/session'
import cities from '../../domain/tcm/bazi/cities.json'
import { heavenNow } from './core/heaven'
import type { TongueAbstract } from '../../domain/tcm/tongue'
export function TongueCapture({store,modelStore=store,onCaptured,disabled=false,onBusyChange}:{store:LocalStore;modelStore?:LocalStore;onCaptured:(record:TongueAbstract,at:Date)=>Promise<void>;disabled?:boolean;onBusyChange?:(busy:boolean)=>void}) {
 const input=useRef<HTMLInputElement>(null),mounted=useRef(true),lock=useRef(false)
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 const [city,setCity]=useState('')
 useEffect(()=>{void loadProfile(store).then(profile=>{if(mounted.current)setCity(profile.city.value??'')}).catch(()=>{})},[store])
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 const capture=async(element:HTMLInputElement)=>{
  let file:File|null=element.files?.[0]??null
  element.value=''
  if(!file||lock.current||disabled)return
  lock.current=true;setBusy(true);onBusyChange?.(true);setError('')
  let bytes:Uint8Array|null=null
  try {
   const type=file.type
   if(file.size>10*1024*1024)throw Error('照片太大，请重新拍摄')
   bytes=new Uint8Array(await file.arrayBuffer());file=null
   const [config,profile]=await Promise.all([loadPersonalModel(modelStore),loadProfile(store)])
   if(!config)throw Error('请先接入支持看图的模型')
   if(!profile.city.value)throw Error('请先选择居住城市')
   const at=new Date(),time=await heavenNow(store,at)
   if(!time.city)throw Error('请先选择居住城市')
   const context={shichen:time.shichen,jieqi:time.jieqi,city:time.city}
   const result=await abstractTongue({bytes,type},context,createVisionClient(config))
   if(mounted.current)await onCaptured(result,at)
  } catch(cause) {if(mounted.current)setError(cause instanceof Error?cause.message:'未能读取，请重新拍摄')}
  finally {file=null;bytes?.fill(0);bytes=null;lock.current=false;if(mounted.current){setBusy(false);onBusyChange?.(false)}}
 }
 return <div><label>居住城市<select aria-label="舌象记录的居住城市" value={city} disabled={busy||disabled} onChange={async event=>{const value=event.target.value;try {const profile=await loadProfile(store);await saveProfile(store,{...profile,city:{value:value||null,source:'student'}});if(mounted.current)setCity(value)}catch{setError('城市未能保存，请重试')}}}><option value="">请选择城市</option>{cities.map(place=><option key={place.nameZh} value={place.nameZh}>{place.nameZh}</option>)}</select></label><input ref={input} type="file" aria-label="选择舌象照片" accept="image/png,image/jpeg,image/webp" capture="environment" hidden onChange={event=>void capture(event.currentTarget)}/><button disabled={disabled||busy||!city} onClick={()=>input.current?.click()}>{busy?'正在生成舌象示意…':'拍舌象 / 重拍'}</button>{error&&<p role="alert">{error}</p>}</div>
}
