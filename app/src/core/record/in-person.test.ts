import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { Encounter } from './types'
import { signEncounter, verifySignedEncounter, type SignedEncounterEvent } from './sign'
import { RECORD_COLLECTIONS, type RecordStore } from './handover'
import {
  IN_PERSON_COLLECTIONS,
  InPersonUndeliveredError,
  addInPersonPhoto,
  intakeDisplayLabel,
  loadInPersonDraft,
  knownStudents,
  recordIntakeField,
  retryInPersonHandover,
  saveInPersonDraft,
  signAndHandoverInPerson,
  startInPersonEncounter,
} from './in-person'

// 合成身份与合成病历，不使用任何真实资料。
const teacherKey = generateSecretKey()
const teacher = getPublicKey(teacherKey)
const student = getPublicKey(generateSecretKey())
const now = new Date('2026-10-17T08:00:00.000Z')
const ENCOUNTER_ID = 'a'.repeat(32)
const PHOTO = { id: 'att-1', type: 'photo' as const, sha256: 'b'.repeat(64), bytes: 3 }

function fresh(): Encounter {
  return startInPersonEncounter({ teacher, student, now, id: ENCOUNTER_ID })
}

class MemoryStore implements RecordStore {
  private data = new Map<string, Map<string, unknown>>()
  async put(collection: string, key: string, value: unknown) {
    if (!this.data.has(collection)) this.data.set(collection, new Map())
    this.data.get(collection)!.set(key, value)
  }
  async get(collection: string, key: string) {
    return this.data.get(collection)?.get(key)
  }
  async delete(collection: string, key: string) {
    this.data.get(collection)?.delete(key)
  }
  async list(collection: string) {
    return [...(this.data.get(collection)?.entries() ?? [])].map(([key, value]) => ({ key, value }))
  }
}

function forgedWithKind(content: Encounter): SignedEncounterEvent {
  return finalizeEvent({
    kind: 2730,
    created_at: Math.floor(Date.parse(content.createdAt) / 1000),
    tags: [['encounter', content.id, String(content.version)], ['p', content.student]],
    content: JSON.stringify(content),
  }, teacherKey) as SignedEncounterEvent
}

describe('M1-12 面诊记录验收', () => {
  it('1 面诊 intake 为老师代录时可以签字；同样的病历把 kind 改成 remote_async 就签不了', () => {
    const recorded = recordIntakeField(fresh(), 'chiefComplaint', '最近睡不好')
    expect(recorded.redFlag).toBeNull()
    const encounter = recorded.encounter
    expect(encounter.kind).toBe('in_person')
    expect(encounter.intake.chiefComplaint).toEqual({ value: '最近睡不好', source: 'teacher', note: 'in_person' })
    const signed = signEncounter(encounter, teacherKey)
    expect(signed.kind).toBe(2730)
    expect(signed.tags).toContainEqual(['p', student])
    // 唯一例外只认 kind === 'in_person'；改成远程异步后同一份病历签不了。
    const remote: Encounter = { ...encounter, kind: 'remote_async' }
    expect(() => signEncounter(remote, teacherKey)).toThrow('intake')
    // 面诊里老师代录也必须带 note: 'in_person'，否则照旧拒绝。
    const noNote: Encounter = {
      ...encounter,
      intake: { ...encounter.intake, chiefComplaint: { value: '最近睡不好', source: 'teacher' } },
    }
    expect(() => signEncounter(noNote, teacherKey)).toThrow('intake')
  })

  it('2 学生端接受面诊病历并在主诉旁标“老师代录”；改成 remote_async 的签名病历被拒收', () => {
    const encounter = recordIntakeField(fresh(), 'chiefComplaint', '最近睡不好').encounter
    const signed = signEncounter(encounter, teacherKey)
    const received = verifySignedEncounter(signed, { student, teacher })
    expect(received.kind).toBe('in_person')
    expect(intakeDisplayLabel(received, 'chiefComplaint')).toBe('老师代录')
    expect(intakeDisplayLabel(received, 'presentIllness')).toBe('未知')
    // 同样的老师代录内容，若 kind 是 remote_async，学生端拒收。
    const remote: Encounter = { ...encounter, kind: 'remote_async' }
    expect(() => verifySignedEncounter(forgedWithKind(remote), { student, teacher })).toThrow('intake')
    // 学生自己写的病史仍标“学生陈述”。
    const withStudent: Encounter = {
      ...encounter,
      intake: { ...encounter.intake, history: { value: '过敏性鼻炎', source: 'student' } },
    }
    expect(intakeDisplayLabel(withStudent, 'history')).toBe('学生陈述')
  })

  it('3 老师录入急症文字：显示就医提示，但记录可以继续', () => {
    const first = recordIntakeField(fresh(), 'chiefComplaint', '胸口压着疼，出冷汗')
    expect(first.redFlag?.hit).toBe(true)
    expect(first.encounter.intake.chiefComplaint).toEqual({
      value: '胸口压着疼，出冷汗',
      source: 'teacher',
      note: 'in_person',
    })
    // 老师在现场判断，记录不被阻断：继续录入下一项，之前的内容仍在。
    const second = recordIntakeField(first.encounter, 'medsAllergies', '无')
    expect(second.redFlag).toBeNull()
    expect(second.encounter.intake.chiefComplaint.value).toContain('胸口')
    expect(second.encounter.intake.medsAllergies).toEqual({ value: '无', source: 'teacher', note: 'in_person' })
    // 清空一项回到未知，不留老师来源。
    const cleared = recordIntakeField(second.encounter, 'chiefComplaint', '   ')
    expect(cleared.encounter.intake.chiefComplaint).toEqual({ value: null, source: 'unknown' })
  })

  it('4 签字交还后老师端查不到照片和代录原文；未送达时全部保留并可重发', async () => {
    const store = new MemoryStore()
    const encounter = addInPersonPhoto(recordIntakeField(fresh(), 'chiefComplaint', 'SYNTHETIC_CHIEF').encounter, PHOTO)
    await store.put(RECORD_COLLECTIONS.attachments, PHOTO.id, new Uint8Array([1, 2, 3]))
    await saveInPersonDraft(store, encounter)
    expect((await loadInPersonDraft(store))?.id).toBe(encounter.id)

    const sent: { type: string; id: string }[] = []
    const index = await signAndHandoverInPerson({
      store,
      encounter,
      draft: encounter,
      privateKey: teacherKey,
      send: async (type, payload) => { sent.push({ type, id: payload.id }) },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('record.signed')
    expect(index.encounterId).toBe(encounter.id)
    // 照片字节与代录草稿都删了。
    expect(await store.get(RECORD_COLLECTIONS.attachments, PHOTO.id)).toBeUndefined()
    expect(await store.get(IN_PERSON_COLLECTIONS.draft, encounter.id)).toBeUndefined()
    // 老师端只留索引，不含病历内容。
    const stored = await store.get(RECORD_COLLECTIONS.signedEncounters, encounter.id + '-v1') as Record<string, unknown>
    expect(Object.keys(stored).sort()).toEqual(['createdAt', 'encounterId', 'eventId', 'student', 'version'])
    expect(JSON.stringify(stored)).not.toContain('SYNTHETIC_CHIEF')
    // 日志只有时间和病历 id；去标识医案不含代录原文。
    const logs = await store.list(RECORD_COLLECTIONS.recordLog)
    expect(logs).toHaveLength(1)
    expect(Object.keys(logs[0].value as object).sort()).toEqual(['at', 'encounterId'])
    const caseBook = await store.get(RECORD_COLLECTIONS.caseBook, encounter.id + '-v1')
    expect(JSON.stringify(caseBook)).not.toContain('SYNTHETIC_CHIEF')

    // 未送达：抛带签名事件 id 的错误，资料和暂存都保留。
    const offline = new MemoryStore()
    const retryEncounter = addInPersonPhoto(recordIntakeField(fresh(), 'chiefComplaint', 'SYNTHETIC_RETRY').encounter, PHOTO)
    await offline.put(RECORD_COLLECTIONS.attachments, PHOTO.id, new Uint8Array([1, 2, 3]))
    await saveInPersonDraft(offline, retryEncounter)
    let thrown: unknown
    try {
      await signAndHandoverInPerson({
        store: offline,
        encounter: retryEncounter,
        draft: retryEncounter,
        privateKey: teacherKey,
        send: async () => { throw new Error('offline') },
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InPersonUndeliveredError)
    const pending = await offline.list(RECORD_COLLECTIONS.pendingHandover)
    expect(pending).toHaveLength(1)
    expect((thrown as InPersonUndeliveredError).eventId).toBe(pending[0].key)
    expect(await offline.get(IN_PERSON_COLLECTIONS.draft, retryEncounter.id)).toBeDefined()
    expect(await offline.get(RECORD_COLLECTIONS.attachments, PHOTO.id)).toBeDefined()

    // 重发成功后才销毁并落库。
    const resent: string[] = []
    const retried = await retryInPersonHandover(offline, pending[0].key, async (_type, payload) => { resent.push(payload.id) })
    expect(resent).toEqual([pending[0].key])
    expect(retried.encounterId).toBe(retryEncounter.id)
    expect(await offline.get(IN_PERSON_COLLECTIONS.draft, retryEncounter.id)).toBeUndefined()
    expect(await offline.get(RECORD_COLLECTIONS.attachments, PHOTO.id)).toBeUndefined()
    expect(await offline.list(RECORD_COLLECTIONS.pendingHandover)).toHaveLength(0)
  })

  it('5 界面 375px 可用，截图产物在 docs/screenshots', () => {
    const css = readFileSync(new URL('../../in-person.css', import.meta.url), 'utf8')
    expect(css).toContain('max-width: 375px')
    expect(existsSync(new URL('../../../../docs/screenshots/in-person-375.png', import.meta.url))).toBe(true)
  })
})

it('M1-20 首次收到问诊即可选学生，不需已有签字记录或手填身份',async()=>{const store=new MemoryStore();await store.put('consult-package','first',{encounter:fresh()});expect(await knownStudents(store)).toEqual([student]);await store.put('signed-encounters','old',{student});expect(await knownStudents(store)).toEqual([student])})
