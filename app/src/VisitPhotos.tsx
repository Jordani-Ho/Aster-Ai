import { useRef,useState } from 'react'
import type { LocalStore } from './core/store'
import type { Encounter } from './core/record/types'
import { addInPersonPhoto,removeInPersonPhoto } from './core/record/in-person'
import { processVisitPhoto } from './core/record/visit-photo'
export function VisitPhotos({store,encounter,onChange}:{store:LocalStore;encounter:Encounter;onChange:(value:Encounter)=>void}) {
 const input=useRef<HTMLInputElement>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[caption,setCaption]=useState('')
 const add=async (element:HTMLInputElement)=>{
  const file=element.files?.[0];element.value='';if(!file||busy)return
  setBusy(true);setError('');let bytes:Uint8Array|undefined
  try {
   bytes=new Uint8Array(await file.arrayBuffer())
   const photo=await processVisitPhoto({bytes,type:file.type},{existingCount:encounter.intake.attachments.filter(ref=>ref.description !== undefined).length})
   const ref={...photo.ref,description:caption.trim()};const next=addInPersonPhoto(encounter,ref)
   await store.put('attachments',ref.id,photo.data);onChange(next);setCaption('')
  } catch(cause) {setError(cause instanceof Error?cause.message:'照片未能保存，请重试。')}
  finally {bytes?.fill(0);setBusy(false)}
 }
 return <section aria-label="患处照片"><label>照片说明（部位、样子）<input maxLength={200} value={caption} onChange={e=>setCaption(e.target.value)}/></label>
  <input ref={input} type="file" accept="image/*" capture="environment" hidden aria-label="选择患处照片" onChange={e=>void add(e.currentTarget)}/>
  <button type="button" disabled={busy} onClick={()=>input.current?.click()}>{busy?'正在处理…':'拍患处'}</button>
  {error&&<p role="alert">{error}</p>}
  {encounter.intake.attachments.filter(ref=>ref.description !== undefined).map((ref,i)=><p key={ref.id}>照片 {i+1} {ref.description}<button type="button" disabled={busy} onClick={()=>{void store.delete('attachments',ref.id).then(()=>onChange(removeInPersonPhoto(encounter,ref.id))).catch(()=>setError('删除照片失败，请重试。'))}}>删除</button></p>)}
 </section>
}
