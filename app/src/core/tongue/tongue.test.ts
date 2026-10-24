import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type LocalStore } from '../store'
import type { VisionClient } from '../llm/vision'
import { captureTongue, latestTongueCrop, listTongueDays, loadTongue, saveTongue, TONGUE_CROPS } from './index'
import type { PhotoCodec, TongueCropCodec } from '../intake/photo'
import { TONGUE_TOO_FAR_MESSAGE } from './failures'
import { addTongue, buildConsultPackage, emptyProfile, markReviewed, startSession, INTAKE_COLLECTIONS } from '../intake/session'
import template from '../../../../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../../../../domain/tcm/templates/types'
import type { Encounter, Field } from '../record/types'
import {
  parseTongueAbstract, parseTongueBox, parseTongueFeatures, tongueColorNote, tongueNeedsCheck,
  tongueSvg, tongueSummary, withTongueFeature,
  type TongueAbstract, type TongueFeatures,
} from '../../../../domain/tcm/tongue'
import { runRetention } from '../records/retention'
import { updateFingerprint, loadFingerprint } from '../records/fingerprint'
import { TONGUE_LEVEL_DEFAULT, loadTongueLevel, saveTongueLevel } from './level'

// 全部用合成图、合成身份、fake-indexeddb；不连真实 relay/gateway，也不含真人照片。
const PNG = readFileSync(new URL('../abstractor/fixtures/tongue.png', import.meta.url))
const W = 480, H = 480
const TONGUE_PIXEL = [230, 150, 160, 255]
const NOSE_PIXEL = [255, 0, 200, 255]
const BACKGROUND = [248, 248, 244, 255]
const CONTEXT = { shichen: '辰', jieqi: '寒露', city: '合成城' }
const FEATURES: TongueFeatures = { color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: 'uncertain', cracks: [], confidence: 0.7 }
const DAY = 86400000
const closers: LocalStore[] = []
afterEach(() => { while (closers.length) closers.pop()!.close() })

async function newStore(): Promise<LocalStore> {
  const store = await openStore(createIdentity(), { factory: new IDBFactory(), name: crypto.randomUUID() })
  closers.push(store)
  return store
}

// 合成图：舌头占中间 240×240（粉色），左上角一块“鼻子”色块（品红），背景米白。
function syntheticRaster(): { pixels: Uint8Array; width: number; height: number } {
  const pixels = new Uint8Array(W * H * 4)
  const put = (x: number, y: number, rgba: number[]) => { const at = (y * W + x) * 4; pixels.set(rgba, at) }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, BACKGROUND)
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) put(x, y, NOSE_PIXEL)
  for (let y = 120; y < 360; y++) for (let x = 120; x < 360; x++) put(x, y, TONGUE_PIXEL)
  return { pixels, width: W, height: H }
}

// V2-20：captureTongue 现在先走 processPhoto（长边 ≤1600、重编码 JPEG）。单元测试注入合成编解码：
// 解码报告 480×480、重编码返回最小合法 JPEG 头，裁剪仍用像素级 rasterCodec。
function syntheticPhotoCodec(raster = syntheticRaster()): PhotoCodec {
  return {
    async decode() { return { source: raster, width: raster.width, height: raster.height } },
    draw() {
      return { toJpeg: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }
    },
  }
}

// 可注入的裁剪编解码：crop 只取矩形内的像素，输出原始 RGBA 字节（便于断言“鼻子像素没进来”）。
function rasterCodec(raster = syntheticRaster()): TongueCropCodec {
  return {
    async decode() { return { source: raster, width: raster.width, height: raster.height } },
    crop(source, rect, out) {
      const src = source as { pixels: Uint8Array; width: number }
      const bytes = new Uint8Array(out.width * out.height * 4)
      for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
        const sx = rect.x + Math.min(rect.width - 1, Math.floor((x + 0.5) * rect.width / out.width))
        const sy = rect.y + Math.min(rect.height - 1, Math.floor((y + 0.5) * rect.height / out.height))
        const from = (sy * src.width + sx) * 4
        bytes.set(src.pixels.subarray(from, from + 4), (y * out.width + x) * 4)
      }
      return { toJpeg: async () => bytes }
    },
  }
}

function model(box: unknown, lightingNote = false): VisionClient {
  return { describe: async () => JSON.stringify({ ...FEATURES, box, lightingNote }) }
}

function containsPixel(bytes: Uint8Array, rgba: number[]): boolean {
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    if (bytes[i] === rgba[0] && bytes[i + 1] === rgba[1] && bytes[i + 2] === rgba[2] && bytes[i + 3] === rgba[3]) return true
  }
  return false
}

function recordOf(features: Partial<TongueFeatures> = {}, extra: Partial<TongueAbstract> = {}): TongueAbstract {
  const merged = parseTongueFeatures({ ...FEATURES, ...features })
  return parseTongueAbstract({ kind: 'tongue', features: merged, svg: tongueSvg(merged), shichen: '辰', jieqi: '寒露', city: '北京市', ...extra })
}

describe('V2-08 验收 1–2（V2-20 改门槛）：只留舌头框内的裁剪图，短边不够不生成记录', () => {
  it('合成图（舌头 + 鼻子色块）处理后只存舌头框内裁剪图，找不到鼻子像素；原图字节清零', async () => {
    const store = await newStore()
    const photo = { bytes: new Uint8Array(PNG), type: 'image/png' }
    const original = photo.bytes!
    // 舌头框 (0.25, 0.25, 0.5, 0.5) → 像素矩形 (120,120,240,240)，只覆盖舌头，不含左上角鼻子；短边 240 ≥160。
    const { record, crop } = await captureTongue(photo, CONTEXT, model({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }), { codec: rasterCodec(), photoCodec: syntheticPhotoCodec() })
    expect(photo.bytes).toBeNull()
    expect(original.every(byte => byte === 0)).toBe(true)
    expect(record.crop?.bytes).toBe(crop.length)
    expect(containsPixel(crop, TONGUE_PIXEL)).toBe(true)
    expect(containsPixel(crop, NOSE_PIXEL)).toBe(false)

    await saveTongue(store, record, new Date('2026-10-18T12:00:00Z'), crop)
    const stored = await loadTongue(store, '2026-10-18')
    expect(stored?.crop?.id).toBe(record.crop?.id)
    const crops = await store.list(TONGUE_CROPS)
    expect(crops).toHaveLength(1)
    const bytes = (crops[0].value as unknown as { data: Uint8Array }).data
    expect(containsPixel(bytes, NOSE_PIXEL)).toBe(false)
    // 任何集合里都找不到原图像节（PNG magic 或整段 base64）。
    const dump = JSON.stringify(await Promise.all(['tongue-records', TONGUE_CROPS, 'intake-attachments'].map(name => store.list(name))))
    expect(dump).not.toContain(PNG.toString('base64'))
  })

  it('裁剪后短边 96 <160 → 提示靠近一点，不生成记录，原图仍清零；面积不再是门槛', async () => {
    const store = await newStore()
    const photo = { bytes: new Uint8Array(PNG), type: 'image/png' }
    const original = photo.bytes!
    // 面积仍有 10%，但短边只有 96：V2-20 起按短边判，必须拒。
    expect(() => parseTongueBox({ x: 0.1, y: 0.1, width: 0.6, height: 0.6 })).not.toThrow()
    await expect(captureTongue(photo, CONTEXT, model({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }), { codec: rasterCodec(), photoCodec: syntheticPhotoCodec() }))
      .rejects.toThrow(TONGUE_TOO_FAR_MESSAGE)
    expect(photo.bytes).toBeNull()
    expect(original.every(byte => byte === 0)).toBe(true)
    expect(await store.list('tongue-records')).toEqual([])
    expect(await store.list(TONGUE_CROPS)).toEqual([])
  })

  it('0–1000 坐标与多余字段能解析；越界仍拒绝', () => {
    expect(parseTongueBox({ x: 120, y: 120, width: 240, height: 240, score: 0.9 })).toEqual({ x: 0.12, y: 0.12, width: 0.24, height: 0.24 })
    expect(() => parseTongueBox({ x: 0.1, y: 0.1, width: 0.95, height: 0.9 })).toThrow()
    expect(() => parseTongueBox({ x: 100, y: 100, width: 950, height: 900 })).toThrow()
  })
})

describe('V2-08 验收 3：不确定 → 老师改“有” → 病历有、指纹计数 +1', () => {
  it('齿痕不确定在摘要里写“不确定”；老师改成有后摘要是“有，位置不确定”', () => {
    const record = recordOf({ teeth: 'uncertain' })
    expect(tongueSummary(record.features)).toContain('齿痕不确定')
    const edited = withTongueFeature(record, 'teeth', 'present')
    expect(tongueSummary(edited.features)).toContain('齿痕有，位置不确定')
    expect(edited.svg).not.toBe(record.svg)
  })

  it('签字时模型原值 vs 老师定值只记计数：齿痕：模型不确定→老师有', async () => {
    const store = await newStore()
    const teacher = 'c'.repeat(64)
    const candidate = recordOf({ teeth: 'uncertain' })
    const final = withTongueFeature(candidate, 'teeth', 'present')
    await updateFingerprint(store, teacher, encounterWith([candidate]), encounterWith([final]))
    const fingerprint = await loadFingerprint(store, teacher)
    expect(fingerprint?.tongueDiffs['齿痕：模型不确定→老师有']).toBe(1)
    // 只记计数，不存图、不存学生身份。
    const dump = JSON.stringify(await store.list('teacher-fingerprint'))
    expect(dump).not.toContain('image')
    expect(dump).not.toContain('b'.repeat(64))
  })
})

describe('V2-08 验收 4：光线偏色“颜色仅供参考”，老师改值后提示不消失', () => {
  it('两张图共同标题显示颜色仅供参考，舌色/苔色行带待核对；改值后拍摄提示仍在', () => {
    const record = recordOf({}, { lightingNote: true })
    expect(tongueColorNote(record)).toBe('颜色仅供参考')
    expect(tongueNeedsCheck(record, 'color')).toBe(true)
    expect(tongueNeedsCheck(record, 'coatingColor')).toBe(true)
    expect(tongueNeedsCheck(record, 'teeth')).toBe(false)
    const edited = withTongueFeature(record, 'color', 'red')
    expect(tongueColorNote(edited)).toBe('颜色仅供参考')
    expect(edited.features.color).toBe('red')
    // 学生端与老师端都用同一个 TonguePair（同一条提示），两端不会各写一套。
    expect(readFileSync(new URL('../../RemoteReview.tsx', import.meta.url), 'utf8')).toContain("from './TonguePair'")
    // V2-16 学生首页的“照镜子”用同一份颜色提示；完整对照仍由 TonguePair 提供。
    expect(readFileSync(new URL('../../StudentToday.tsx', import.meta.url), 'utf8')).toContain('tongueColorNote')
    expect(readFileSync(new URL('../../TonguePair.tsx', import.meta.url), 'utf8')).toContain('tongueColorNote')
  })
})

describe('V2-08 验收 5：镜子只留最新裁剪图；问诊裁剪图按保留期限两端删', () => {
  it('连拍三天只剩最新一张裁剪图，三条特征记录都在', async () => {
    const store = await newStore()
    const crops = [new Uint8Array([1, 1, 1]), new Uint8Array([2, 2, 2]), new Uint8Array([3, 3, 3])]
    const days = ['2026-10-16', '2026-10-17', '2026-10-18']
    let last: TongueAbstract | null = null
    for (const [index, day] of days.entries()) {
      const record = recordOf({ confidence: 0.5 + index * 0.1 }, { crop: { id: String(index) + 'a'.repeat(31), type: 'photo', sha256: String(index) + 'b'.repeat(63), bytes: 3 } })
      last = record
      await saveTongue(store, record, new Date(day + 'T12:00:00Z'), crops[index])
      expect((await store.list(TONGUE_CROPS)).length).toBe(1)
    }
    expect(await listTongueDays(store)).toEqual(days)
    const latest = await latestTongueCrop(store)
    expect(latest?.id).toBe(last!.crop!.id)
    expect(Array.from(latest!.data)).toEqual([3, 3, 3])
  })

  it('问诊裁剪图过保留期限两端都删；签字病历里的特征值不依赖图片', async () => {
    const NOW = new Date('2026-10-18T12:00:00.000Z')
    const OLD = new Date(NOW.getTime() - 40 * DAY)
    const cropRef = { id: 'd'.repeat(32), type: 'photo' as const, sha256: 'e'.repeat(64), bytes: 3 }
    const record = recordOf({}, { crop: cropRef })
    const eventJson = JSON.stringify({ intake: { tongues: [record] } })

    const student = await newStore()
    await student.put('intake-sent', 'f'.repeat(32), { encounter: { createdAt: OLD.toISOString() }, history: [], attachments: [cropRef] })
    await student.put(INTAKE_COLLECTIONS.attachmentData, cropRef.id, new Uint8Array([7, 7, 7]))
    await student.put(TONGUE_CROPS, cropRef.id, { id: cropRef.id, at: OLD.toISOString(), data: new Uint8Array([7, 7, 7]) } as never)
    await student.put('student-records', 'a'.repeat(64), { id: 'a'.repeat(32), teacher: 'c'.repeat(64), createdAt: OLD.toISOString(), eventJson, version: 1 })
    const studentRun = await runRetention(student, 'student', { now: NOW, days: 30 })
    expect(studentRun.deleted['intake-attachments']).toBe(1)
    expect(studentRun.deleted['tongue-crops']).toBe(1)
    expect(await student.list('intake-attachments')).toEqual([])
    expect(await student.list(TONGUE_CROPS)).toEqual([])

    const teacher = await newStore()
    await teacher.put('settings', 'role', 'teacher' as never)
    await teacher.put('consult-package', 'a'.repeat(32), { encounter: { createdAt: OLD.toISOString() }, receivedAt: OLD.toISOString(), attachments: [cropRef], history: [], sender: 'b'.repeat(64), droppedHistory: 0 })
    await teacher.put('teacher-records', 'a'.repeat(64), { eventId: 'a'.repeat(64), encounterId: 'a'.repeat(32), version: 1, student: 'b'.repeat(64), createdAt: OLD.toISOString(), eventJson })
    await teacher.put('attachments', cropRef.id, new Uint8Array([7, 7, 7]))
    const teacherRun = await runRetention(teacher, 'teacher', { now: NOW, days: 30 })
    expect(teacherRun.deleted.attachments).toBe(1)
    expect(await teacher.list('attachments')).toEqual([])

    // 特征值写在签字病历里；图片删掉后仍能从事件内容读出（不是从图片推出来的）。
    const parsed = JSON.parse(eventJson) as { intake: { tongues: TongueAbstract[] } }
    expect(parsed.intake.tongues[0].features.teeth).toBe('uncertain')
    expect(tongueSummary(parsed.intake.tongues[0].features)).toContain('齿痕不确定')
  })
})

describe('V2-08 验收 6：没有代码把原图写进存储或发给中继', () => {
  it('问诊包与所有集合里都没有原图；只有裁剪图字节在附件通道里', async () => {
    const photo = { bytes: new Uint8Array(PNG), type: 'image/png' }
    const { record, crop } = await captureTongue(photo, CONTEXT, model({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }), { codec: rasterCodec(), photoCodec: syntheticPhotoCodec() })
    const session = addTongue(markReviewed({ ...startSession({ student: 'a'.repeat(64), teacher: 'b'.repeat(64), template: template as TeacherTemplate }), phase: 'confirm' as const }), record)
    const pkg = buildConsultPackage(session, emptyProfile(), [], [{ ref: { ...record.crop! }, data: crop }])
    const wire = JSON.stringify(pkg)
    expect(wire).not.toContain(PNG.toString('base64'))
    expect(wire).not.toContain('data:image')
    expect(pkg.attachments).toHaveLength(1)
    expect(pkg.encounter.intake.attachments).toEqual([])
    expect(pkg.encounter.intake.tongues?.[0].crop?.id).toBe(record.crop?.id)
  })

  it('拍照入口不直接写存储/发中继；读图模块不碰存储或传输', () => {
    const capture = readFileSync(new URL('../../TongueCapture.tsx', import.meta.url), 'utf8')
    expect(capture).not.toMatch(/\.put\(|\.send\(|sendEnvelope|transport/)
    const abstractor = readFileSync(new URL('../abstractor/index.ts', import.meta.url), 'utf8')
    expect(abstractor).not.toMatch(/from '.*(?:store|transport|inbox)/)
    const crop = readFileSync(new URL('./crop.ts', import.meta.url), 'utf8')
    expect(crop).not.toMatch(/store\.|\.send\(|transport/)
  })
})

describe('V2-08 级别：默认第一级，本版只开放 1', () => {
  it('tongueLevel 默认 1；保存 3 被拒绝，仍是第一级', async () => {
    const store = await newStore()
    expect(TONGUE_LEVEL_DEFAULT).toBe(1)
    expect(await loadTongueLevel(store)).toBe(1)
    await saveTongueLevel(store, 1)
    await expect(saveTongueLevel(store, 3)).rejects.toThrow('只开放第一级')
    expect(await loadTongueLevel(store)).toBe(1)
  })
})

// 最小远程病历：intake 只有合成主诉，其余未知；用于思想指纹。
function encounterWith(tongues: TongueAbstract[]): Encounter {
  const unknown = <T,>(): Field<T> => ({ value: null, source: 'unknown' })
  const text = <T,>(value: T): Field<T> => ({ value, source: 'student' })
  return {
    id: 'a'.repeat(32), version: 1, kind: 'remote_async', student: 'b'.repeat(64), teacher: 'c'.repeat(64), createdAt: '2026-10-18T12:00:00.000Z',
    profile: { alias: text('合成'), gender: unknown(), age: unknown(), bazi: unknown(), city: text('北京市') },
    intake: { chiefComplaint: text('睡不着'), presentIllness: unknown(), history: unknown(), medsAllergies: unknown(), attachments: [], tongues },
    fourExams: { look: unknown(), listenSmell: unknown(), ask: unknown(), pulse: unknown() },
    judgment: { symptomSummary: unknown(), pattern: unknown(), mechanism: unknown(), rationale: unknown() },
    plan: { principle: unknown(), prescription: unknown(), homework: [], advice: unknown() },
  }
}
