import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type LocalStore } from '../store'
import { addTeacher, createInbox } from '../inbox'
import {
  CARE_PLAN_TYPE,
  currentCarePlan,
  signCarePlan,
  storeCarePlan,
  verifySignedCarePlan,
  type CarePlan,
  type SignedCarePlanEvent,
} from './index'

// 只用合成身份与合成方案，不连真实中继。
const phrase = 'leader monkey parrot ring guide accident before fence cannon height naive bean'
const teacher = createIdentity(phrase, 'english', 0)
const student = createIdentity(phrase, 'english', 1)
const stranger = createIdentity(phrase, 'english', 2)

function plan(version: number, overrides: Partial<CarePlan> = {}): CarePlan {
  return {
    constitution: '平和质',
    points: ['每天早睡', '多喝温水'],
    avoid: ['生冷', '熬夜'],
    updatedAt: '2026-10-17T08:00:00.000Z',
    version,
    ...overrides,
  }
}

describe('careplan 签发与验签', () => {
  it('老师签发、学生按老师与 p 标签验签通过', () => {
    const event = signCarePlan(plan(1), student.publicKey, teacher.privateKey)
    expect(event.kind).toBe(2731)
    expect(event.pubkey).toBe(teacher.publicKey)
    const verified = verifySignedCarePlan(event, { student: student.publicKey, teacher: teacher.publicKey })
    expect(verified.version).toBe(1)
    expect(verified.points).toEqual(['每天早睡', '多喝温水'])
  })

  it('内容被改后验签失败（id 绑定，E-004）', () => {
    const event = signCarePlan(plan(1), student.publicKey, teacher.privateKey)
    const tampered: SignedCarePlanEvent = { ...event, content: JSON.stringify(plan(1, { avoid: ['改成别的'] })) }
    expect(() => verifySignedCarePlan(tampered, { student: student.publicKey, teacher: teacher.publicKey })).toThrow()
  })

  it('陌生成员签发的被拒绝（签名人不是老师）', () => {
    const event = signCarePlan(plan(1), student.publicKey, stranger.privateKey)
    expect(() => verifySignedCarePlan(event, { student: student.publicKey, teacher: teacher.publicKey })).toThrow('签名人')
  })
})

describe('careplan 存储版本替换', () => {
  it('只接受更新的版本，旧版迟到不覆盖', async () => {
    const store = await openStore(student, { factory: new IDBFactory() })
    await storeCarePlan(store, teacher.publicKey, plan(1))
    expect((await currentCarePlan(store, teacher.publicKey))?.version).toBe(1)
    // 同版或旧版不覆盖
    expect(await storeCarePlan(store, teacher.publicKey, plan(1))).toBe(false)
    expect((await currentCarePlan(store, teacher.publicKey))?.version).toBe(1)
    // 新版本替换
    expect(await storeCarePlan(store, teacher.publicKey, plan(2, { points: ['更新后的要点'] }))).toBe(true)
    expect((await currentCarePlan(store, teacher.publicKey))?.points).toEqual(['更新后的要点'])
    store.close()
  })
})

describe('careplan 经信封收件（验收第 1 条）', () => {
  async function receiveInbox(store: LocalStore, sender: string, payload: unknown) {
    await createInbox({ identity: student, store }).receive({
      id: 'a'.repeat(64),
      sender,
      at: 0,
      envelope: { type: CARE_PLAN_TYPE, version: 1, payload },
    })
  }

  it('陌生成员签发的被丢弃，名单内老师的被接收并按版本替换', async () => {
    const store = await openStore(student, { factory: new IDBFactory() })
    await addTeacher(store, teacher.publicKey)

    // 陌生成员：验签前先查名单，直接丢弃
    await receiveInbox(store, stranger.publicKey, signCarePlan(plan(1), student.publicKey, stranger.privateKey))
    expect(await currentCarePlan(store, stranger.publicKey)).toBeNull()

    // 名单内老师：接收 v1，再收 v2 替换
    await receiveInbox(store, teacher.publicKey, signCarePlan(plan(1), student.publicKey, teacher.privateKey))
    expect((await currentCarePlan(store, teacher.publicKey))?.version).toBe(1)
    await receiveInbox(store, teacher.publicKey, signCarePlan(plan(2, { points: ['新的要点'] }), student.publicKey, teacher.privateKey))
    expect((await currentCarePlan(store, teacher.publicKey))?.version).toBe(2)
    store.close()
  })
})
