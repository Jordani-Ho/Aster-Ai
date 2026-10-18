import { it, expect, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { encryptVideo, writeVideoCipher, VIDEO_COLLECTION } from './index'
import { receivePracticeMessage, replyToPractice, sendPractice, REVIEW_COLLECTION, OUTGOING_COLLECTION } from './review'
import { startInPersonEncounter } from '../record/in-person'
import { signEncounter } from '../record/sign'

it('student submits two references only; teacher replies once and deletes temporary grants and bytes', async () => {
  const phrase = 'leader monkey parrot ring guide accident before fence cannon height naive bean'
  const teacher = createIdentity(phrase, 'english'), student = createIdentity(phrase, 'english', 1)
  const store = await openStore(teacher, { name: crypto.randomUUID(), factory: new IDBFactory() })
  try {
    const original = await encryptVideo(new Uint8Array(32), 'video/mp4', 60, { teacher: teacher.publicKey, student: student.publicKey, homework: 'hw', role: 'original' })
    const practice = await encryptVideo(new Uint8Array(48), 'video/mp4', 30, { ...original.ref.context, role: 'practice' })
    const payload = { id: crypto.randomUUID(), encounterId: 'a'.repeat(32), homework: 'hw', original: original.ref, practice: practice.ref }
    await store.put('signed-encounters', 'index', { student: student.publicKey, encounterId: payload.encounterId })
    const message = { id: 'm', sender: student.publicKey, at: Math.floor(Date.now() / 1000), envelope: { version: 1 as const, type: 'practice.submit', payload } }
    await receivePracticeMessage(teacher, store, { ...message, sender: 'c'.repeat(64) })
    expect(await store.list(REVIEW_COLLECTION)).toHaveLength(0)
    await receivePracticeMessage(teacher, store, message)
    expect(await store.list(REVIEW_COLLECTION)).toHaveLength(1)
    await writeVideoCipher(store, original.ref.sha256, original.bytes)
    await writeVideoCipher(store, practice.ref.sha256, practice.bytes)
    await expect(replyToPractice(teacher, store, payload.id, '合成回复', async () => { throw Error('offline') })).rejects.toThrow()
    expect(await store.list(REVIEW_COLLECTION)).toHaveLength(1)
    await replyToPractice(teacher, store, payload.id, '合成回复', async (recipient, envelope) => {
      expect(recipient).toBe(student.publicKey)
      expect(envelope).toEqual({ type: 'practice.reply', version: 1, payload: { id: payload.id, text: '合成回复' } })
    })
    expect(await store.list(REVIEW_COLLECTION)).toHaveLength(0)
    expect(await store.list(VIDEO_COLLECTION)).toHaveLength(0)
    await receivePracticeMessage(teacher, store, message)
    expect(await store.list(REVIEW_COLLECTION)).toHaveLength(0)
  } finally { store.close() }
})

it('family practice uses the child inbox and encrypted slice while HTTP membership uses the guardian', async()=>{
 const phrase='leader monkey parrot ring guide accident before fence cannon height naive bean'
 const guardian=createIdentity(phrase,'english'),child=createIdentity(phrase,'english',1),teacher=createIdentity(phrase,'english',2)
 const parent=await openStore(guardian,{name:crypto.randomUUID(),factory:new IDBFactory()}),store=parent.scoped('f1-')
 try{
  await store.put('settings','teachers',[teacher.publicKey])
  const context={student:child.publicKey,teacher:teacher.publicKey,homework:'family-hw',role:'original' as const}
  const original=await encryptVideo(new Uint8Array(32),'video/mp4',60,context),practice=await encryptVideo(new Uint8Array(48),'video/mp4',30,{...context,role:'practice'})
  const encounter=startInPersonEncounter({student:child.publicKey,teacher:teacher.publicKey})
  encounter.plan.homework=[{id:context.homework,title:'合成家人练习',detail:'合成',source:'teacher',schedule:{kind:'daily',time:'08:00'},video:original.ref}]
  const record={encounter,teacher:teacher.publicKey,event:signEncounter(encounter,teacher.privateKey)}
  await writeVideoCipher(store,original.ref.sha256,original.bytes);await writeVideoCipher(store,practice.ref.sha256,practice.bytes)
  let uploads=0
  vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{
   const headers=init.headers as Record<string,string>,auth=JSON.parse(Buffer.from(headers.authorization.slice(6),'base64url').toString())
   expect(auth.pubkey).toBe(guardian.publicKey);uploads++
   return Response.json({sha256:headers['x-sha-256'],size:(init.body as Uint8Array).length})
  })
  const id=await sendPractice(record,context.homework,practice.ref,child,guardian,store,'https://app.example/media',async(recipient,envelope)=>{expect(recipient).toBe(teacher.publicKey);expect(JSON.stringify(envelope).length).toBeLessThan(12000)})
  expect(uploads).toBe(2);expect(await parent.list(OUTGOING_COLLECTION)).toHaveLength(0)
  await receivePracticeMessage(child,store,{id:'reply',sender:teacher.publicKey,at:Date.now()/1000,envelope:{version:1,type:'practice.reply',payload:{id,text:'合成家人回复'}}})
  expect((await store.get(OUTGOING_COLLECTION,id) as {reply?:string}).reply).toBe('合成家人回复')
  await sendPractice(record,context.homework,practice.ref,child,guardian,store,'https://app.example/media',async()=>{throw Error('sent clip must not be resent')})
  expect((await store.get(OUTGOING_COLLECTION,id) as {reply?:string}).reply).toBe('合成家人回复')
 }finally{vi.unstubAllGlobals();parent.close()}
})
