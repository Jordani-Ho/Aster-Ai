import { it, expect, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { startInPersonEncounter, addInPersonPhoto, saveInPersonDraft, signAndHandoverInPerson, retryInPersonHandover, InPersonUndeliveredError } from '../record/in-person'
import { signEncounter } from '../record/sign'
import { addTeacher, createInbox, sendInPersonRecord, sha256Hex, toBase64 } from './index'
const words='leader monkey parrot ring guide accident before fence cannon height naive bean'
async function setup() {
 const teacher=createIdentity(words,'english'),student=createIdentity(words,'english',1)
 const source=await openStore(teacher,{factory:new IDBFactory()}),target=await openStore(student,{factory:new IDBFactory()})
 const data=new Uint8Array([1,2,3]),ref={id:'synthetic-photo',type:'photo' as const,sha256:await sha256Hex(data),bytes:data.length}
 const encounter=addInPersonPhoto(startInPersonEncounter({teacher:teacher.publicKey,student:student.publicKey}),ref)
 await source.put('attachments',ref.id,data);await saveInPersonDraft(source,encounter);await addTeacher(target,teacher.publicKey)
 const inbox=createInbox({identity:student,store:target})
 const deliver=async(envelope:any)=>inbox.receive({id:crypto.randomUUID(),at:1,sender:teacher.publicKey,envelope})
 return {teacher,student,source,target,data,ref,encounter,deliver,close(){source.close();target.close();teacher.privateKey.fill(0);student.privateKey.fill(0)}}
}
it('面诊照片与签名病历加密发出后才删除老师原件；照片先到也能验签入学生本机',async()=>{
 const f=await setup(),packets:any[]=[]
 try{
  await signAndHandoverInPerson({store:f.source,encounter:f.encounter,draft:f.encounter,privateKey:f.teacher.privateKey,send:async(_type,event)=>sendInPersonRecord(f.source,async(_to,envelope)=>{packets.push(envelope)},f.student.publicKey,event)})
  expect(packets.map(p=>p.type)).toEqual(['record.signed','record.attachment'])
  for(const packet of [...packets].reverse())await f.deliver(packet)
  expect(await f.source.get('attachments',f.ref.id)).toBeUndefined()
  expect(await f.source.list('in-person-draft')).toEqual([])
  expect(await f.target.list('student-records')).toHaveLength(1)
  const index=(await f.target.list('record-photo-index'))[0]
  expect(index.key).toMatch(/^[0-9a-f-]{36}$/)
  expect((index.value as any).sha256).toBe(f.ref.sha256)
  expect(await f.target.get('record-photos',(index.value as any).dataKey)).toEqual(f.data)
 }finally{f.close()}
})
it('照片传输失败保留老师原件和同一签名，重发成功后才清理',async()=>{
 const f=await setup();let fail=true,pending='';const ids:string[]=[]
 const send=async(_type:'record.signed',event:any)=>sendInPersonRecord(f.source,async(_to,envelope)=>{if(envelope.type==='record.attachment'&&fail)throw Error('offline');if(envelope.type==='record.signed')ids.push((envelope.payload as any).id);await f.deliver(envelope)},f.student.publicKey,event)
 try{
  try{await signAndHandoverInPerson({store:f.source,encounter:f.encounter,draft:f.encounter,privateKey:f.teacher.privateKey,send})}catch(cause){expect(cause).toBeInstanceOf(InPersonUndeliveredError);pending=(cause as InPersonUndeliveredError).eventId}
  expect(await f.source.get('attachments',f.ref.id)).toEqual(f.data)
  expect(await f.target.list('record-photos')).toEqual([])
  fail=false;await retryInPersonHandover(f.source,pending,send)
  expect(ids).toEqual([pending,pending]);expect(await f.source.get('attachments',f.ref.id)).toBeUndefined()
  expect(await f.target.list('record-photos')).toHaveLength(1)
 }finally{f.close()}
})
it('改照片、改签名、陌生发件人均拒收；源照片缺失时不先发残缺病历',async()=>{
 const f=await setup()
 try{
  const event=JSON.parse(JSON.stringify(signEncounter(f.encounter,f.teacher.privateKey)))
  await f.deliver({type:'record.attachment',version:1,payload:{event,refId:f.ref.id,data:toBase64(new Uint8Array([3,2,1]))}})
  await f.deliver({type:'record.attachment',version:1,payload:{event:{...event,sig:'0'.repeat(128)},refId:f.ref.id,data:toBase64(f.data)}})
  const inbox=createInbox({identity:f.student,store:f.target})
  await inbox.receive({id:'a'.repeat(64),at:1,sender:'c'.repeat(64),envelope:{type:'record.attachment',version:1,payload:{event,refId:f.ref.id,data:toBase64(f.data)}}})
  expect(await f.target.list('record-photos')).toEqual([]);expect(await f.target.list('student-records')).toEqual([])
  await f.source.delete('attachments',f.ref.id)
  const send=vi.fn()
  await expect(sendInPersonRecord(f.source,send,f.student.publicKey,event)).rejects.toThrow('照片')
  expect(send).not.toHaveBeenCalled()
 }finally{f.close()}
})
