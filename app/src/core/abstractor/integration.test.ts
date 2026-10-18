import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { captureTongue, loadTongue } from '../tongue'
import { addTongue, startSession, saveDraft, loadDraft, markReviewed, confirmAndSend, emptyProfile } from '../intake/session'
import template from '../../../../domain/tcm/templates/default.json'
import { consultEnvelope, createInbox, addTeacher } from '../inbox'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import { signEncounter, verifySignedEncounter } from '../record/sign'
import { parseTongueAbstract } from '../../../../domain/tcm/tongue'
const features = {color:'pale',coatingColor:'white',coatingThickness:'thin',shape:'wide',teeth:[],cracks:[],confidence:0.7}
const context = {shichen:'辰',jieqi:'寒露',city:'合成城'}
const png = readFileSync(new URL('./fixtures/tongue.png', import.meta.url))
const identity = () => createIdentity()

it('镜子抽象落入普通 IndexedDB，家人隔离；问诊草稿恢复、发送和老师收件只含抽象记录', async () => {
 const student = identity(), teacher = createIdentity()
 const store = await openStore(student,{factory:new IDBFactory(), name:crypto.randomUUID()})
 const target = await openStore(teacher,{factory:new IDBFactory(), name:crypto.randomUUID()})
 try {
  const scoped = store.scoped('family-1'), input = {bytes:new Uint8Array(png),type:'image/png'}
  const original = input.bytes
  const result = await captureTongue(scoped,input,context,{describe:async()=>JSON.stringify(features)},new Date('2026-10-18T12:00:00Z'))
  expect(original.every(x=>x===0)).toBe(true);expect(input.bytes).toBeNull()
  expect(await loadTongue(scoped,'2026-10-18')).toEqual(result)
  expect(await loadTongue(store,'2026-10-18')).toBeNull()
  let session = startSession({student:student.publicKey,teacher:teacher.publicKey,template:template as TeacherTemplate})
  session = addTongue(session,result)
  session = markReviewed({...session,phase:'confirm'})
  await saveDraft(scoped,session)
  const restored = (await loadDraft(scoped))!
  expect(restored.tongues).toEqual([result])
  await addTeacher(scoped,teacher.publicKey)
  const inbox = createInbox({identity:teacher,store:target})
  let wire = ''
  await confirmAndSend(scoped,restored,emptyProfile(),[],[],async pkg=>{
   expect(pkg.attachments).toEqual([])
   const signed=signEncounter(pkg.encounter,teacher.privateKey)
   expect(verifySignedEncounter(signed,{student:student.publicKey,teacher:teacher.publicKey}).intake.tongues).toEqual([result])
   expect(()=>parseTongueAbstract({...result,svg:'<svg onload="alert(1)"/>'})).toThrow()
   const envelope = consultEnvelope(pkg);wire=JSON.stringify(envelope)
   await inbox.receive({id:crypto.randomUUID(),sender:student.publicKey,at:Math.floor(Date.now()/1000),envelope})
  })
  const records = await target.list('consult-package')
  expect(records).toHaveLength(1)
  expect((records[0].value as any).encounter.intake.tongues).toEqual([result])
  const all = JSON.stringify({wire,mirror:await scoped.list('tongue-records'),sent:await scoped.list('intake-sent'),outbox:await scoped.list('intake-outbox'),records})
  expect(all).not.toContain(png.toString('base64'));expect(all).not.toContain('image_url')
  for(const collection of ['tongue-photos','intake-attachments','attachments']) {
   expect(await scoped.list(collection)).toEqual([]);expect(await target.list(collection)).toEqual([])
  }
 } finally {store.close();target.close()}
})

it('模型失败不落盘、不覆盖先前结果，输入仍清除',async()=>{
 const store=await openStore(identity(),{factory:new IDBFactory(),name:crypto.randomUUID()})
 try {
  const at = new Date('2026-10-18T12:00:00Z')
  const saved=await captureTongue(store,{bytes:new Uint8Array(png),type:'image/png'},context,{describe:async()=>JSON.stringify(features)},at)
  const photo={bytes:new Uint8Array(png),type:'image/png'}, original=photo.bytes
  await expect(captureTongue(store,photo,context,{describe:async()=>{throw Error('failure')}},at)).rejects.toThrow('重新拍')
  expect(photo.bytes).toBeNull();expect(original.every(x=>x===0)).toBe(true)
  expect(await loadTongue(store,'2026-10-18')).toEqual(saved)
 } finally {store.close()}
})
