import { describe,it,expect } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { startInPersonEncounter,addInPersonPhoto,saveInPersonDraft } from './in-person'
import { appendVisitAudioChunk,loadVisitAudio } from './visit-audio'
import { appendVisitOriginal,loadVisitOriginals } from './visit-originals'
import { clearVisitRawMaterials } from './visit-cleanup'
describe('面诊用完清理',()=>{
 it('只清本次录音、原话、照片与草稿，可重复执行',async()=>{
  const teacher=createIdentity(),student=createIdentity(),store=await openStore(teacher,{factory:new IDBFactory()})
  try {
   const e=addInPersonPhoto(startInPersonEncounter({teacher:teacher.publicKey,student:student.publicKey}),{id:'synthetic',type:'photo',sha256:'a'.repeat(64),bytes:1})
   const crop={id:'tongue-crop',type:'photo' as const,sha256:'b'.repeat(64),bytes:1}
   e.intake.attachments.push(crop);e.intake.tongues=[{crop} as unknown as NonNullable<typeof e.intake.tongues>[number]]
   await store.put('attachments',crop.id,new Uint8Array([3]))
   await appendVisitAudioChunk(store,e.id,'s','audio/webm',new Uint8Array([1]));await appendVisitOriginal(store,e.id,'合成原话')
   await store.put('attachments','synthetic',new Uint8Array([1]));await store.put('attachments','other',new Uint8Array([2]));await saveInPersonDraft(store,e)
   await clearVisitRawMaterials(store,e);await clearVisitRawMaterials(store,e)
   expect(await loadVisitAudio(store,e.id,'s')).toBeNull();expect(await loadVisitOriginals(store,e.id)).toEqual([])
   expect(await store.get('attachments','synthetic')).toBeUndefined();expect(await store.get('attachments','other')).toEqual(new Uint8Array([2]));expect(await store.get('attachments','tongue-crop')).toEqual(new Uint8Array([3]));expect(await store.get('in-person-draft',e.id)).toBeUndefined()
  } finally {store.close();teacher.privateKey.fill(0);student.privateKey.fill(0)}
 })
})
