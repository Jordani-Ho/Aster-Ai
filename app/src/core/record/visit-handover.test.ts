import { it,expect } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { addTeacher,createInbox,recordPhotos,sendInPersonRecord,sha256Hex } from '../inbox'
import { addInPersonPhoto,recordIntakeField,startInPersonEncounter,signAndHandoverInPerson,saveInPersonDraft } from './in-person'
import { appendVisitOriginal,loadVisitOriginals } from './visit-originals'
import { appendVisitAudioChunk,loadVisitAudio } from './visit-audio'
import { clearVisitRawMaterials } from './visit-cleanup'
it('合成面诊照片交还后学生能读取说明，老师只清本次原始材料；发送失败先保留',async()=>{
 const teacher=createIdentity(),student=createIdentity(),source=await openStore(teacher,{factory:new IDBFactory()}),target=await openStore(student,{factory:new IDBFactory()})
 try {
  const data=new Uint8Array([1,2,3]),ref={id:'synthetic',type:'photo' as const,sha256:await sha256Hex(data),bytes:data.length,description:'合成说明'}
  let encounter=recordIntakeField(startInPersonEncounter({teacher:teacher.publicKey,student:student.publicKey}),'chiefComplaint','合成主诉')
  encounter=addInPersonPhoto(encounter,ref);await saveInPersonDraft(source,encounter);await source.put('attachments',ref.id,data)
  await appendVisitOriginal(source,encounter.id,'合成原话');await appendVisitAudioChunk(source,encounter.id,'s','audio/webm',new Uint8Array([4]))
  await addTeacher(target,teacher.publicKey);const inbox=createInbox({identity:student,store:target})
  let fail=true
  const send=async (_type:'record.signed',event:import('./sign').SignedEncounterEvent)=>sendInPersonRecord(source,async (_recipient,envelope)=>{
   if(fail && envelope.type==='record.attachment')throw Error('offline')
   await inbox.receive({id:crypto.randomUUID(),at:1,sender:teacher.publicKey,envelope})
  },student.publicKey,event)
  await expect(signAndHandoverInPerson({encounter,privateKey:teacher.privateKey,store:source,send})).rejects.toThrow('offline')
  expect(await source.get('attachments',ref.id)).toEqual(data);expect(await loadVisitAudio(source,encounter.id,'s')).not.toBeNull()
  fail=false;await signAndHandoverInPerson({encounter,privateKey:teacher.privateKey,store:source,send});await clearVisitRawMaterials(source,encounter)
  expect(await source.get('attachments',ref.id)).toBeUndefined();expect(await loadVisitOriginals(source,encounter.id)).toEqual([]);expect(await loadVisitAudio(source,encounter.id,'s')).toBeNull()
  const { listReceivedRecords }=await import('../inbox'),records=await listReceivedRecords(target,student)
  const photos=await recordPhotos(target,records[0]);expect(photos[0].data).toEqual(data);expect(photos[0].ref.description).toBe('合成说明')
 } finally {source.close();target.close();teacher.privateKey.fill(0);student.privateKey.fill(0)}
})
