import { useEffect,useState } from 'react'
import type { LocalStore } from './core/store'
import { listVisitAudioSegments, loadVisitAudio } from './core/record/visit-audio'
export function VisitAudioPlayer({store,visitId,revision}:{store:LocalStore;visitId:string;revision:number}) {
 const [urls,setUrls]=useState<string[]>([]),[error,setError]=useState('')
 useEffect(()=>{
  let active=true;const created:string[]=[]
  void (async()=>{
   const segments=await listVisitAudioSegments(store,visitId)
   for(const segment of segments) {
    const audio=await loadVisitAudio(store,visitId,segment.id)
    if(audio)created.push(URL.createObjectURL(new Blob([audio.data.slice().buffer as ArrayBuffer],{type:audio.mimeType})))
   }
   if(active){setUrls([...created]);setError('')}else created.forEach(url=>URL.revokeObjectURL(url))
  })().catch(()=>{created.forEach(url=>URL.revokeObjectURL(url));if(active)setError('录音暂时无法回放。')})
  return()=>{active=false;created.forEach(url=>URL.revokeObjectURL(url))}
 },[store,visitId,revision])
 return <section aria-label="录音回放">{urls.map((url,index)=><div key={url}><p>录音 {index+1}</p><audio controls src={url}/></div>)}{error&&<p role="status">{error}</p>}</section>
}
