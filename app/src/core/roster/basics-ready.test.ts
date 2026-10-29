import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { rememberTeacherStudent } from '../records/teacher'
import { attachWaitingBasics, receiveStudentBasicsReady, queueStudentBasicsReady, sendPendingStudentBasics } from './basics-ready'

it('资料已齐只收名单学生的五项，拒绝坏输入和较早消息', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() }), student = createIdentity().publicKey
  const five = { alias: '合成小明', gender: 'other', age: 30, bazi: null, city: '北京市' }
  try {
    expect(await receiveStudentBasicsReady(store, 'bad', five, 100)).toBe(false)
    expect(await receiveStudentBasicsReady(store, student, five, 0)).toBe(false)
    expect(await receiveStudentBasicsReady(store, student, five, 100)).toBe(true)
    expect(await store.get('teacher-student-basics', student)).toBeUndefined()
    await rememberTeacherStudent(store, student)
    await attachWaitingBasics(store, student)
    expect((await store.get('teacher-student-basics', student) as {alias:string}).alias).toBe('合成小明')
    expect(await store.get('teacher-students', student)).toMatchObject({ city:'北京市', cityUpdatedAt:100 })
    for (const bad of [{...five, extra: 'X'}, {...five, age: -1}, {...five, alias: ''}, {...five, gender: 'bad'}, {...five, city: ''}, {...five, bazi: {}}, {...five, bazi: {year:null,month:null,day:'甲子',hour:null,flags:['x'],extra:1}}, {...five, age: 1.5}])
      expect(await receiveStudentBasicsReady(store, student, bad, 100)).toBe(false)
    expect(await receiveStudentBasicsReady(store, student, five, 100)).toBe(false)
    expect(await receiveStudentBasicsReady(store, student, {...five, alias:'过期'}, 99)).toBe(false)
    expect(await receiveStudentBasicsReady(store, student, {...five, alias:'相同时间'}, 100)).toBe(false)
    expect(await receiveStudentBasicsReady(store, student, {...five, alias:'合成小红'}, 101)).toBe(true)
    expect((await store.get('teacher-student-basics', student) as {alias:string}).alias).toBe('合成小红')
    expect(await store.get('teacher-students', student)).toMatchObject({ city:'北京市', cityUpdatedAt:101 })
    const { rememberTeacherStudentCity } = await import('../records/teacher')
    await rememberTeacherStudentCity(store, student, '上海市', 103)
    await receiveStudentBasicsReady(store, student, five, 102)
    expect(await store.get('teacher-students', student)).toMatchObject({ city:'上海市', cityUpdatedAt:103 })
  } finally { store.close() }
})

it('完整资料只发送五项给自己的老师，发送失败后可以补发', async () => {
  const store = await openStore(createIdentity(), { factory: new IDBFactory() }), teacher = createIdentity().publicKey
  try {
    await store.put('settings', 'teachers', [teacher])
    await queueStudentBasicsReady(store)
    expect(await store.list('student-basics-pending')).toHaveLength(0)
    const { saveBasics } = await import('../basics')
    await saveBasics(store, { alias: '合成小明', gender: 'male', birthDate: '1990-05-06', birthShichen: null, birthPlace: '北京市', city: '北京市', routine: { wake: '07:00', sleep:'23:00' }, history:'不发送的合成病史' })
    await queueStudentBasicsReady(store)
    await expect(sendPendingStudentBasics(store, async () => { throw Error('offline') })).rejects.toThrow('offline')
    expect(await store.list('student-basics-pending')).toHaveLength(1)
    const sent: unknown[] = []
    await sendPendingStudentBasics(store, async (to, envelope) => { expect(to).toBe(teacher); sent.push(envelope) })
    expect((sent[0] as { type:string }).type).toBe('student.basics-ready')
    const payload = (sent[0] as { payload: Record<string,unknown> }).payload
    expect(Object.keys(payload).sort()).toEqual(['age','alias','bazi','city','gender'])
    expect(payload.alias).toBe('合成小明')
    expect(await store.list('student-basics-pending')).toHaveLength(0)
    await queueStudentBasicsReady(store)
    await store.put('settings', 'teachers', [])
    await sendPendingStudentBasics(store, async () => { throw Error('removed teacher must not receive') })
    expect(await store.list('student-basics-pending')).toHaveLength(0)
  } finally { store.close() }
})

it('五项经加密信封按身份送达，迟到的进馆消息可启用它', async () => {
  const student = createIdentity(), teacher = createIdentity(), store = await openStore(teacher, { factory: new IDBFactory() })
  try {
    const { wrapMessage, openMessage } = await import('../transport/crypto')
    const { createInbox } = await import('../inbox')
    const { makeInvite } = await import('../onboarding')
    await store.put('settings', 'role', { role: 'teacher' })
    const inbox = createInbox({ identity: teacher, store })
    const payload = { alias:'合成小明', gender:'other', age:30, bazi:null, city:'北京市' }
    const now = Math.floor(Date.now()/1000)
    const packet = wrapMessage(student.privateKey, teacher.publicKey, { type:'student.basics-ready', version:1, payload }, now)
    const event = packet.events.find(event => event.tags.some(tag => tag[0] === 'p' && tag[1] === teacher.publicKey))!
    expect(JSON.stringify(event)).not.toContain('合成小明')
    await inbox.receive(openMessage(event, teacher.privateKey, now))
    expect(await store.get('teacher-student-basics', student.publicKey)).toBeUndefined()
    const invite = makeInvite(teacher, 'https://synthetic.example/invite/redeem', now, 3600)
    const join = wrapMessage(student.privateKey, teacher.publicKey, { type:'roster.join', version:1, payload:{invite} }, now + 1)
    const joinEvent = join.events.find(event => event.tags.some(tag => tag[0] === 'p' && tag[1] === teacher.publicKey))!
    await inbox.receive(openMessage(joinEvent, teacher.privateKey, now + 1))
    expect(await store.get('teacher-student-basics', student.publicKey)).toMatchObject(payload)
    expect(await store.get('teacher-basics-waiting', student.publicKey)).toBeUndefined()
  } finally { store.close() }
})
