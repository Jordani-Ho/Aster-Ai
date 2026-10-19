import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import { captureTongue, loadTongue, saveTongue } from '../tongue'
import { addTongue, startSession, saveDraft, loadDraft, markReviewed, confirmAndSend, emptyProfile } from '../intake/session'
import template from '../../../../domain/tcm/templates/default.json'
import { attachmentEnvelope, consultEnvelope, createInbox, addTeacher } from '../inbox'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import { signEncounter, verifySignedEncounter } from '../record/sign'
import type { TongueCropCodec } from '../intake/photo'
import { parseTongueAbstract } from '../../../../domain/tcm/tongue'

// 全部合成：固定 PNG、假裁剪编解码、合成身份、fake-indexeddb，不连真实 relay。
const features = { color: 'pale', coatingColor: 'white', coatingThickness: 'thin', shape: 'wide', teeth: [], cracks: [], confidence: 0.7 }
const box = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }
const context = { shichen: '辰', jieqi: '寒露', city: '合成城' }
const png = readFileSync(new URL('./fixtures/tongue.png', import.meta.url))
const CROP = new Uint8Array([9, 8, 7, 6])
const codec: TongueCropCodec = {
  async decode() { return { source: {}, width: 200, height: 200 } },
  crop() { return { toJpeg: async () => CROP } },
}
const model = (patch: Record<string, unknown> = {}) => ({ describe: async () => JSON.stringify({ ...features, box, lightingNote: false, ...patch }) })
const identity = () => createIdentity()

it('镜子：只留裁剪图与候选特征，家人隔离；问诊包带裁剪图而不是原图', async () => {
  const student = identity(), teacher = createIdentity()
  const store = await openStore(student, { factory: new IDBFactory(), name: crypto.randomUUID() })
  const target = await openStore(teacher, { factory: new IDBFactory(), name: crypto.randomUUID() })
  try {
    const scoped = store.scoped('family-1'), input = { bytes: new Uint8Array(png), type: 'image/png' }
    const original = input.bytes
    const at = new Date('2026-10-18T12:00:00Z')
    const { record, crop } = await captureTongue(input, context, model(), { codec })
    expect(original.every(x => x === 0)).toBe(true); expect(input.bytes).toBeNull()
    await saveTongue(scoped, record, at, crop)
    expect(await loadTongue(scoped, '2026-10-18')).toEqual(record)
    expect(await loadTongue(store, '2026-10-18')).toBeNull()
    expect(await scoped.get('tongue-crops', record.crop!.id)).toBeDefined()
    let session = startSession({ student: student.publicKey, teacher: teacher.publicKey, template: template as TeacherTemplate })
    session = addTongue(session, record)
    session = markReviewed({ ...session, phase: 'confirm' })
    await saveDraft(scoped, session)
    const restored = (await loadDraft(scoped))!
    expect(restored.tongues).toEqual([record])
    await addTeacher(scoped, teacher.publicKey)
    const inbox = createInbox({ identity: teacher, store: target })
    let wire = ''
    await confirmAndSend(scoped, restored, emptyProfile(), [], [{ ref: { ...record.crop! }, data: crop }], async pkg => {
      expect(pkg.attachments).toHaveLength(1)
      expect(pkg.encounter.intake.attachments).toEqual([])
      const signed = signEncounter(pkg.encounter, teacher.privateKey)
      expect(verifySignedEncounter(signed, { student: student.publicKey, teacher: teacher.publicKey }).intake.tongues).toEqual([record])
      expect(() => parseTongueAbstract({ ...record, svg: '<svg onload="alert(1)"/>' })).toThrow()
      const envelope = consultEnvelope(pkg)
      wire = JSON.stringify(envelope)
      await inbox.receive({ id: crypto.randomUUID(), sender: student.publicKey, at: Math.floor(Date.now() / 1000), envelope })
      // 裁剪图走既有附件通道（与真实 sendConsultPackage 一样，一张一条信封）。
      await inbox.receive({ id: crypto.randomUUID(), sender: student.publicKey, at: Math.floor(Date.now() / 1000), envelope: attachmentEnvelope(pkg.encounter.id, record.crop!, crop) })
    })
    const records = await target.list('consult-package')
    expect(records).toHaveLength(1)
    expect((records[0].value as any).encounter.intake.tongues).toEqual([record])
    expect(await target.get('attachments', record.crop!.id)).toEqual(CROP)
    const all = JSON.stringify({ wire, mirror: await scoped.list('tongue-records'), sent: await scoped.list('intake-sent'), outbox: await scoped.list('intake-outbox'), records })
    expect(all).not.toContain(png.toString('base64')); expect(all).not.toContain('image_url')
  } finally { store.close(); target.close() }
})

it('模型或拍摄失败不落盘、不覆盖先前记录，输入仍清除', async () => {
  const store = await openStore(identity(), { factory: new IDBFactory(), name: crypto.randomUUID() })
  try {
    const at = new Date('2026-10-18T12:00:00Z')
    const { record, crop } = await captureTongue({ bytes: new Uint8Array(png), type: 'image/png' }, context, model(), { codec })
    await saveTongue(store, record, at, crop)
    const photo = { bytes: new Uint8Array(png), type: 'image/png' }, original = photo.bytes
    await expect(captureTongue(photo, context, { describe: async () => { throw Error('failure') } }, { codec })).rejects.toThrow('重新拍')
    expect(photo.bytes).toBeNull(); expect(original.every(x => x === 0)).toBe(true)
    expect(await loadTongue(store, '2026-10-18')).toEqual(record)
    // 框太小同样不生成记录、不覆盖旧图。
    const tiny = { bytes: new Uint8Array(png), type: 'image/png' }, tinyOriginal = tiny.bytes
    await expect(captureTongue(tiny, context, model({ box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }), { codec })).rejects.toThrow('没拍清舌头')
    expect(tiny.bytes).toBeNull(); expect(tinyOriginal.every(x => x === 0)).toBe(true)
    expect(await loadTongue(store, '2026-10-18')).toEqual(record)
  } finally { store.close() }
})
