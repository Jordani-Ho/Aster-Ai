import {useEffect,useState} from 'react'
import type {LocalStore} from './core/store'
import type {Encounter} from './core/record/types'
import {TonguePair} from './TonguePair'

export function VisitReviewPhotos({store,encounter}:{store:LocalStore;encounter:Encounter}) {
  const [photos,setPhotos]=useState<{url:string;description:string}[]>([])
  useEffect(()=>{
    let active=true; const urls:string[]=[]
    void (async()=>{
      const crops=new Set(encounter.intake.tongues?.flatMap(tongue=>tongue.crop?[tongue.crop.id]:[])??[])
      const result:{url:string;description:string}[]=[]
      for(const ref of encounter.intake.attachments) {
        if(ref.type!=='photo'||crops.has(ref.id))continue
        const data=await store.get('attachments',ref.id)
        if(data instanceof Uint8Array) {const url=URL.createObjectURL(new Blob([data.slice().buffer as ArrayBuffer],{type:'image/jpeg'}));urls.push(url);result.push({url,description:ref.description??''})}
      }
      if(active)setPhotos(result);else urls.forEach(URL.revokeObjectURL)
    })().catch(()=>{})
    return ()=>{active=false;urls.forEach(URL.revokeObjectURL)}
  },[store,encounter])
  return <div>{encounter.intake.tongues?.map((tongue,index)=><TonguePair key={index} record={tongue} title="本次舌象" loadCrop={async()=>{const id=tongue.crop?.id;if(!id)return null;const data=await store.get('attachments',id);return data instanceof Uint8Array?data:null}} missingCropState="missing" />)}
    {photos.map(photo=><figure key={photo.url}><img src={photo.url} alt="患处照片" style={{maxWidth:160}}/>{photo.description && <figcaption>{photo.description}</figcaption>}</figure>)}
  </div>
}
