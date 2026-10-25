import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TeacherShell } from '../app/src/TeacherShell'
import { StudentShell } from '../app/src/StudentShell'
import { SignReview } from '../app/src/SignReview'
import { TonguePair } from '../app/src/TonguePair'
import { OpeningGuide } from '../app/src/OpeningGuide'
import { CommunityDashboard } from '../app/src/CommunityDashboard'
import { VersionLine } from '../app/src/VersionLine'
import { StorefrontWelcome } from '../app/src/StorefrontWelcome'
import { createIdentity } from '../app/src/core/identity'
import { openStore, resumeStore } from '../app/src/core/store'
import { createLedgerSync } from '../app/src/core/ledger/sync'
import { knownStudents, startInPersonEncounter } from '../app/src/core/record/in-person'
import { signEncounter } from '../app/src/core/record/sign'
import { markHallOpened, saveGuide } from '../app/src/core/hall'
import { publishStorefront, makeStorefrontEvent, saveReceivedStorefront, saveStorefrontDraft } from '../app/src/core/storefront'
import { saveActiveTeacher } from '../app/src/core/storefront/active'
import { rememberTeacherStudent, saveTeacherRecord } from '../app/src/core/records/teacher'
import { addTeacher } from '../app/src/core/inbox'
import { addFamilyMember, loadFamilyMembers } from '../app/src/core/family'
import { saveTongue } from '../app/src/core/tongue'
import { loadProfile, saveProfile } from '../app/src/core/intake/session'
import { saveBasics } from '../app/src/core/basics'
import { effectiveDay } from '../app/src/core/homework/schedule'
import type { LlmClient } from '../app/src/core/llm'
import type { Wiring } from '../app/src/core/wiring'
import type { TongueAbstract } from '../domain/tcm/tongue'
import type { Encounter } from '../app/src/core/record/types'

// V2-17 新界面第二批浏览器验收：真实组件 + 合成数据；不连中继、不调真实模型。
// 场景：open1–open5 / opening / students / hall / welcome / consult / records / me，
// 以及 V2-16 的 today / visit / student / long / tongue / dashboard。
const scene = new URLSearchParams(location.search).get('scene') ?? 'open1'
const gateway = 'https://phone.synthetic.invalid'
const openScene = /^open[1-5]$/.test(scene)
const studentScene = ['consult', 'records', 'me', 'student', 'newstudent'].includes(scene)

async function node(name: string) {
  const prior = await resumeStore({ name })
  if (prior) return prior
  const identity = createIdentity()
  return { identity, store: await openStore(identity, { name }) }
}

// 模型替身：面诊口述拆分四诊；其余（学生整理/老师起草）给一份合成功夫。
// V2-29：追问由用例控制（每个整理调用按顺序取一条追问列表，默认不追问）；modelCalls 统计模型调用次数。
const intakeControl: { modelCalls: number; replies: { focus: string; text: string }[][] } = { modelCalls: 0, replies: [] }
const stubLlm: LlmClient = {
  complete: async messages => {
    intakeControl.modelCalls += 1
    const system = String(messages[0]?.content ?? '')
    const user = String(messages[1]?.content ?? '')
    if (system.includes('面诊口述拆分四诊')) return JSON.stringify({ look: ['舌淡红，苔薄白'], listenSmell: [], ask: ['入睡难'], pulse: ['脉细弱'] })
    // 学生整理：把学生原话填进字段（模型只能摘学生说过的词）。
    if (user.includes('"missingFocus"')) {
      try {
        const payload = JSON.parse(user) as { texts?: string[]; focusAnswers?: Record<string, string> }
        const chief = payload.texts?.[0] ?? ''
        const answers = Object.values(payload.focusAnswers ?? {}).filter(text => text.trim() !== '')
        const fields: Record<string, string[]> = {}
        if (chief !== '') fields.chiefComplaint = [chief]
        if (answers.length > 0) fields.presentIllness = answers
        return JSON.stringify({ fields, questions: intakeControl.replies.length > 0 ? intakeControl.replies.shift() : [] })
      } catch { /* 落到下面的草稿替身 */ }
    }
    return JSON.stringify({
      fourExams: { ask: { value: '入睡难' } },
      judgment: { symptomSummary: { value: '睡眠困扰' }, pattern: { value: '心脾两虚' } },
      plan: {
        principle: { value: '益气补血' },
        prescription: { value: { items: [{ herb: '黄芪', dose: '10g' }, { herb: '当归', dose: '6g' }], method: '水煎', days: 7 } },
        homework: [{ title: '睡前泡脚', detail: '十五分钟', schedule: { kind: 'daily', time: '21:00' }, durationDays: 7 }],
        advice: { value: '早睡' },
      },
    })
  },
  stream: async () => { throw Error('合成模型不做流式') },
}

const teacher = await node('v217-teacher-' + scene)
// 合成学生也要可恢复：页面被 Vite 重载时不能换一个新身份。
const partner = await node('v217-partner-' + scene)
const student = partner.identity
await teacher.store.put('settings', 'role', { role: 'teacher' })

const now = new Date()
// 与页面同一口径（0 点到 1 点仍算前一天）；否则 CI 在 UTC 0 点多跑时作业还没“开始”，今日作业为空。
const today = effectiveDay(now)
const weekday = (now.getDay() + 6) % 7
const weekStart = (() => { const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - weekday); return [monday.getFullYear(), String(monday.getMonth() + 1).padStart(2, '0'), String(monday.getDate()).padStart(2, '0')].join('-') })()
const daysAgoDate = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 10, 0, 0)
// 合成数据用确定性 id：页面被 Vite 重载、数据被重新种一遍时覆盖同一份，不翻倍。
function seedHex(label: string): string {
  let out = ''
  for (let round = 0; round < 4; round += 1) {
    let hash = 2166136261 ^ round
    for (let index = 0; index < label.length; index += 1) { hash ^= label.charCodeAt(index); hash = Math.imul(hash, 16777619) >>> 0 }
    out += hash.toString(16).padStart(8, '0')
  }
  return out.slice(0, 32)
}

const STOREFRONT = { name: '合成养生馆', displayName: '合成阿慈', emblem: 'leaf' as const, theme: 'warm' as const, intro: '一起照顾日常作息，慢慢练成适合自己的习惯。', welcome: '从每天照镜子开始。' }

const ledger = createLedgerSync({ identity: teacher.identity, store: teacher.store, onChange: () => window.dispatchEvent(new Event('aster:data-changed')), send: async () => crypto.randomUUID() })
const stack = {
  send: async () => 'synthetic-envelope',
  sendConsult: async () => {},
  ledger,
  flushIntakeOutbox: async () => 0,
  close: async () => {},
} as unknown as Wiring
const settingsNode = <details><summary>模型与偏好设置</summary><p>合成设置</p></details>
const modelSettingsNode = <details><summary>我的大模型</summary><p>合成模型设置</p></details>
const status = <><p role="status">中继：已连接</p></>

async function publishHall() {
  if (!(await teacher.store.get('settings', 'hall'))) {
    await markHallOpened(teacher.store)
    await publishStorefront({ store: teacher.store, identity: teacher.identity, storefront: STOREFRONT })
  }
}

function encounterFor(studentKey: string, patch: { alias: string; gender: 'male' | 'female'; age: number; city: string; at: Date; pattern: string; managedBy?: string; id?: string }): Encounter {
  const encounter = startInPersonEncounter({ teacher: teacher.identity.publicKey, student: studentKey, now: patch.at, ...(patch.id ? { id: patch.id } : {}) })
  encounter.kind = 'remote_async'
  encounter.profile.alias = { value: patch.alias, source: 'student' }
  encounter.profile.gender = { value: patch.gender, source: 'student' }
  encounter.profile.age = { value: patch.age, source: 'student' }
  encounter.profile.city = { value: patch.city, source: 'student' }
  if (patch.managedBy) encounter.profile.managedBy = { value: patch.managedBy, source: 'student' }
  encounter.intake.chiefComplaint = { value: '最近睡不好', source: 'student' }
  encounter.judgment.pattern = { value: patch.pattern, source: 'teacher' }
  encounter.judgment.mechanism = { value: '气血不足', source: 'teacher' }
  encounter.plan.principle = { value: '益气补血', source: 'teacher' }
  encounter.plan.prescription = { value: { items: [{ herb: '黄芪', dose: '10g' }, { herb: '当归', dose: '6g' }], method: '水煎', days: 7 }, source: 'teacher' }
  encounter.plan.homework = [{ id: 'h'.repeat(32), title: '泡脚十五分钟', detail: '水温到微微出汗。', schedule: { kind: 'daily', time: '21:00' }, durationDays: 7, source: 'teacher' }]
  encounter.plan.advice = { value: '早睡', source: 'teacher' }
  return encounter
}

interface RosterSeed { alias: string; gender: 'male' | 'female'; age: number; city: string; daysAgo: number; pattern: string; managedBy?: string; report: null | { practiceDays: number; weeklyRate: number | null; streak: number } }

// 06 名单：5 位合成学生；小王有方案快照与 3 次签字病历，李阿姨由小林代管、没有小结。
async function seedRoster(): Promise<string[]> {
  const seeds: RosterSeed[] = [
    { alias: '小王', gender: 'male', age: 34, city: '北京', daysAgo: 0, pattern: '心脾两虚', report: { practiceDays: 5, weeklyRate: 5 / 7, streak: 5 } },
    { alias: '李阿姨', gender: 'female', age: 62, city: '北京', daysAgo: 2, pattern: '脾肾两虚', managedBy: '小林', report: null },
    { alias: '小陈', gender: 'male', age: 28, city: '杭州', daysAgo: 4, pattern: '肝郁脾虚', report: { practiceDays: 0, weeklyRate: 0, streak: 0 } },
    { alias: '小林', gender: 'female', age: 31, city: '上海', daysAgo: 6, pattern: '气血两虚', report: { practiceDays: 4, weeklyRate: 4 / 7, streak: 1 } },
    { alias: '小周', gender: 'male', age: 41, city: '成都', daysAgo: 8, pattern: '脾胃虚弱', report: { practiceDays: 6, weeklyRate: 6 / 7, streak: 6 } },
  ]
  const keys: string[] = []
  for (const [index, seed] of seeds.entries()) {
    const person = await node('v217-roster-' + scene + '-' + index)
    keys.push(person.identity.publicKey)
    await rememberTeacherStudent(teacher.store, person.identity.publicKey)
    if (seed.alias === '小王') {
      for (const days of [30, 14, seed.daysAgo]) {
        await saveTeacherRecord(teacher.store, signEncounter(encounterFor(person.identity.publicKey, { ...seed, at: daysAgoDate(days), id: seedHex('roster-' + scene + '-' + seed.alias + '-' + days) }), teacher.identity.privateKey))
      }
    } else {
      await saveTeacherRecord(teacher.store, signEncounter(encounterFor(person.identity.publicKey, { ...seed, at: daysAgoDate(seed.daysAgo), id: seedHex('roster-' + scene + '-' + seed.alias) }), teacher.identity.privateKey))
    }
    if (seed.report) {
      await teacher.store.put('student-adherence', person.identity.publicKey, {
        student: person.identity.publicKey, weekStart, weeklyRate: seed.report.weeklyRate, streak: seed.report.streak,
        practiceDays: seed.report.practiceDays, scheduled: 7, done: seed.report.practiceDays, receivedAt: daysAgoDate(1).toISOString(),
      })
    }
    if (seed.alias === '小王') {
      await teacher.store.put('care-plan-snapshot', person.identity.publicKey, {
        constitution: '平和质', points: ['作息与日常练习', '洗漱后 · 按揉神门穴两分钟'], avoid: ['生冷'], updatedAt: daysAgoDate(14).toISOString(), version: 1,
      })
    }
  }
  if ((await teacher.store.list('ledger-index')).length === 0) {
    await ledger.open(teacher.identity.publicKey, keys[0])
    await ledger.record(teacher.identity.publicKey, keys[0], { type: 'topup', currency: 'CNY', amount: 12000, at: daysAgoDate(3).toISOString() })
    await ledger.open(teacher.identity.publicKey, keys[1])
    await ledger.record(teacher.identity.publicKey, keys[1], { type: 'topup', currency: 'CNY', amount: 100000, at: daysAgoDate(3).toISOString() })
  }
  return keys
}

// 学生侧工作区（用学生自己的 store/identity，老师是另一位合成身份）：
// 门面/称呼/作业/打卡/三日舌象；records 另存 2 份签字病历；me 另加家人与余额。
async function studentWorkspace(kind: 'consult' | 'records' | 'me', sstore = teacher.store, sidentity = teacher.identity, basics = true) {
  await addTeacher(sstore, teacher.identity.publicKey)
  await saveReceivedStorefront(sstore, makeStorefrontEvent(teacher.identity, STOREFRONT), teacher.identity.publicKey)
  await saveActiveTeacher(sstore, teacher.identity.publicKey, [teacher.identity.publicKey])
  const profile = await loadProfile(sstore)
  await saveProfile(sstore, { ...profile, alias: { value: '合成小王', source: 'student' }, city: { value: '北京市', source: 'student' } })
  // V2-23：已有学生默认填好基础信息；newstudent 场景故意不填，验证第一次问诊前的门槛。
  if (basics) await saveBasics(sstore, { alias: '合成小王', gender: 'male', birthDate: '1990-05-06', birthShichen: null, birthPlace: '北京市', city: '北京市', history: '无', meds: '无', allergies: '无', routine: { wake: '07:00', sleep: '23:00' } })
  await sstore.put('care-plans', teacher.identity.publicKey, {
    constitution: '平和质', points: ['霜降养脾胃。早饭吃温热的，别空腹喝冷饮。'], avoid: ['生冷'], updatedAt: new Date().toISOString(), version: 1,
  })
  const homework = { id: 'h'.repeat(32), title: '泡脚十五分钟', detail: '水温到微微出汗。', schedule: { kind: 'daily' as const, time: '21:00' }, durationDays: 60, source: 'teacher' as const }
  await sstore.put('homework', homework.id, { homework, startsOn: [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate() - 40).padStart(2, '0')].join('-') })
  for (const days of [35, 33, 32, 28, 27, 21, 20, 19, 14, 13, 12, 7, 6, 5, 4, 2]) {
    await sstore.put('checkins', seedHex('checkin-' + kind + '-' + days), { homeworkId: homework.id, at: new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 9, 0, 0).toISOString() })
  }
  const { tongueSvg } = await import('../domain/tcm/tongue')
  const colours = [
    { color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.8 },
    { color: 'pale', coatingColor: 'white', coatingThickness: 'thick', shape: 'wide', teeth: [], cracks: [], confidence: 0.7 },
    { color: 'pink', coatingColor: 'yellow', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.7 },
  ] as const
  for (const [index, features] of colours.entries()) {
    const crop = await tongueCrop()
    const record: TongueAbstract = { kind: 'tongue', features: features as never, svg: tongueSvg(features), shichen: '辰', jieqi: '霜降', city: '北京', crop: { id: String(index + 1).repeat(32), type: 'photo', sha256: 'f'.repeat(64), bytes: crop.length } }
    await saveTongue(sstore, record, daysAgoDate(index * 2), crop)
  }
  if (kind === 'records') {
    for (const [index, pattern] of ['心脾两虚', '气血两虚'].entries()) {
      const encounter = encounterFor(sidentity.publicKey, { alias: '合成小王', gender: 'male', age: 34, city: '北京', at: daysAgoDate(20 - index * 10), pattern, id: seedHex('student-record-' + index) })
      const signed = signEncounter(encounter, teacher.identity.privateKey)
      await sstore.put('student-records', signed.id, { id: signed.id, teacher: teacher.identity.publicKey, createdAt: encounter.createdAt, eventJson: JSON.stringify(signed), version: encounter.version })
    }
  }
  if (kind === 'me') {
    await addFamilyMember(sstore, sidentity, { alias: '李阿姨', relation: 'mother', gender: 'female', birthDate: '1960-01-01', city: '北京市' })
    await ledger.open(teacher.identity.publicKey, sidentity.publicKey)
    await ledger.record(teacher.identity.publicKey, sidentity.publicKey, { type: 'topup', currency: 'CNY', amount: 12000, at: daysAgoDate(2).toISOString() })
  }
}

async function tongueCrop(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 240
  const context = canvas.getContext('2d')!
  context.fillStyle = '#d98f9a'; context.fillRect(0, 0, 240, 240)
  context.fillStyle = '#b46a78'; context.beginPath(); context.ellipse(120, 130, 60, 80, 0, 0, Math.PI * 2); context.fill()
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8))
  return new Uint8Array(await blob!.arrayBuffer())
}

function longEncounter(): Encounter {
  const encounter = startInPersonEncounter({ teacher: teacher.identity.publicKey, student: student.publicKey, id: 'f'.repeat(32) })
  encounter.intake.chiefComplaint = { value: '最近睡不好', source: 'student' }
  encounter.intake.presentIllness = { value: '夜里容易醒，白天没精神。'.repeat(120), source: 'student' }
  encounter.judgment.pattern = { value: '心脾两虚', source: 'ai_draft' }
  encounter.judgment.mechanism = { value: '气血不足', source: 'ai_draft' }
  encounter.plan.prescription = { value: { items: [{ herb: '黄芪', dose: '10g' }], days: 7 }, source: 'ai_draft' }
  encounter.plan.homework = [{ id: 'a'.repeat(32), title: '泡脚', detail: '十五分钟', schedule: { kind: 'daily', time: '21:00' }, source: 'ai_draft' }]
  return encounter
}

// V2-16 旧场景：老师“今天”/面诊需要一条等签字的远程问诊 + 学生周小结。
function remoteEncounter(): Encounter {
  const encounter = startInPersonEncounter({ teacher: teacher.identity.publicKey, student: student.publicKey, id: 'a'.repeat(32), now: new Date('2026-10-22T02:00:00.000Z') })
  encounter.kind = 'remote_async'
  encounter.profile.alias = { value: '合成小王', source: 'student' }
  encounter.profile.gender = { value: 'male', source: 'student' }
  encounter.profile.age = { value: 34, source: 'student' }
  encounter.intake.chiefComplaint = { value: '最近睡不好', source: 'student' }
  encounter.intake.presentIllness = { value: '夜里容易醒，白天没精神。', source: 'student' }
  return encounter
}

async function seedRemote() {
  await rememberTeacherStudent(teacher.store, student.publicKey)
  await teacher.store.put('consult-package', 'a'.repeat(32), {
    encounter: remoteEncounter(), history: [], attachments: [],
    receivedAt: new Date('2026-10-22T02:05:00.000Z').toISOString(), sender: student.publicKey, droppedHistory: 0,
  })
  await teacher.store.put('student-adherence', student.publicKey, {
    student: student.publicKey, weekStart, weeklyRate: 0.3, streak: 0, practiceDays: 2, scheduled: 7, done: 2,
    receivedAt: new Date().toISOString(),
  })
}

// V2-16 学生首页：两条作业、一条习惯已打卡、昨天一张舌象。
async function seedStudentHome() {
  await addTeacher(teacher.store, teacher.identity.publicKey)
  await saveReceivedStorefront(teacher.store, makeStorefrontEvent(teacher.identity, STOREFRONT), teacher.identity.publicKey)
  await saveActiveTeacher(teacher.store, teacher.identity.publicKey, [teacher.identity.publicKey])
  const profile = await loadProfile(teacher.store)
  await saveProfile(teacher.store, { ...profile, alias: { value: '合成小王', source: 'student' }, city: { value: '北京市', source: 'student' } })
  await saveBasics(teacher.store, { alias: '合成小王', gender: 'male', birthDate: '1990-05-06', birthShichen: null, birthPlace: '北京市', city: '北京市', history: '无', meds: '无', allergies: '无', routine: { wake: '07:00', sleep: '23:00' } })
  await teacher.store.put('care-plans', teacher.identity.publicKey, {
    constitution: '平和质', points: ['霜降养脾胃。早饭吃温热的，别空腹喝冷饮。'], avoid: ['生冷'], updatedAt: new Date().toISOString(), version: 1,
  })
  const first = { id: 'c'.repeat(32), title: '泡脚十五分钟', detail: '水温到微微出汗。', schedule: { kind: 'daily' as const, time: '21:00' }, durationDays: 7, source: 'teacher' as const }
  const second = { id: 'd'.repeat(32), title: '按揉神门穴', detail: '每次两分钟。', schedule: { kind: 'habit' as const, anchor: '躺下后' }, durationDays: 7, source: 'teacher' as const }
  await teacher.store.put('homework', first.id, { homework: first, startsOn: today })
  await teacher.store.put('homework', second.id, { homework: second, startsOn: today })
  await teacher.store.put('checkins', seedHex('habit-checkin'), { homeworkId: second.id, at: new Date().toISOString() })
  const features = { color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.8 }
  const { tongueSvg } = await import('../domain/tcm/tongue')
  const crop = await tongueCrop()
  const record: TongueAbstract = { kind: 'tongue', features: features as never, svg: tongueSvg(features), shichen: '辰', jieqi: '霜降', city: '北京', crop: { id: 'e'.repeat(32), type: 'photo', sha256: 'f'.repeat(64), bytes: crop.length } }
  await saveTongue(teacher.store, record, new Date(Date.now() - 86400000), crop)
}

const modelPreset = { provider: 'other', baseUrl: 'https://model.synthetic.invalid/v1', model: 'synthetic', apiKey: 'SYNTHETIC', testedAt: new Date().toISOString() }

function OpeningScene({ preset }: { preset: typeof modelPreset | null }) {
  const [done, setDone] = useState(false)
  if (done) return <main id="phone-done"><h1>已进入老师首页</h1></main>
  return <OpeningGuide identity={teacher.identity} store={teacher.store} gateway={gateway} modelGateway={null} modelConfig={preset} onModelSaved={() => {}} onDone={() => setDone(true)} />
}

async function main() {
  let roster: string[] = []
  const ownStudentScene = studentScene && scene !== 'student'
  // Vite 首次启动可能整页重载一次；合成数据只种一次，否则病历/账本会翻倍。
  const seeded = Boolean(await teacher.store.get('settings', 'v217-seeded'))
  if (!seeded) {
    if (!openScene && scene !== 'welcome' && scene !== 'opening') await publishHall()

    if (scene === 'open2') await saveGuide(teacher.store, { step: 2, firstInvite: null })
    if (scene === 'open3') await saveGuide(teacher.store, { step: 3, firstInvite: null })
    if (scene === 'open4') await saveGuide(teacher.store, { step: 4, firstInvite: null })
    if (scene === 'open5') {
      await markHallOpened(teacher.store)
      await saveGuide(teacher.store, { step: 5, firstInvite: { link: 'https://phone.synthetic.invalid/#invite=synthetic', createdAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
    }
    if (scene === 'open2' || scene === 'open3' || scene === 'open4' || scene === 'open5') {
      await saveStorefrontDraft(teacher.store, { ...STOREFRONT, name: scene === 'open2' ? '' : STOREFRONT.name, intro: scene === 'open2' ? '' : STOREFRONT.intro })
    }
    if (scene === 'students' || scene === 'hall') roster = await seedRoster()
    if (ownStudentScene) await studentWorkspace(scene === 'records' ? 'records' : scene === 'me' ? 'me' : 'consult', partner.store, partner.identity, scene !== 'newstudent')
    if (scene === 'student') await seedStudentHome()
    if (scene === 'today' || scene === 'visit') await seedRemote()
    await teacher.store.put('settings', 'v217-seeded', 1)
  } else if (scene === 'students' || scene === 'hall') {
    roster = await knownStudents(teacher.store)
  }

  const cropped = await tongueCrop()
  const tongueFeatures = { color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.8 }
  const { tongueSvg } = await import('../domain/tcm/tongue')
  const tongue: TongueAbstract = { kind: 'tongue', features: tongueFeatures as never, svg: tongueSvg(tongueFeatures), shichen: '辰', jieqi: '霜降', city: '北京' }
  const long = longEncounter()
  const pagesStore = ownStudentScene ? partner.store : teacher.store
  const pagesIdentity = ownStudentScene ? partner.identity : teacher.identity
  const family = scene === 'me' ? await loadFamilyMembers(pagesStore).catch(() => []) : []
  const familyOptions = family.map(member => ({ account: member.account, alias: member.alias }))

  function Scene() {
    if (openScene) return <OpeningScene preset={scene === 'open1' ? null : modelPreset} />
    if (scene === 'opening') return <OpeningScene preset={null} />
    if (scene === 'dashboard') return <CommunityDashboard relays={[]} />
    // V2-29：只渲染版本行，用来验证“宿主机 APP_VERSION → Vite define → 页面”这条链路。
    if (scene === 'version') return <div className="nl-shell"><VersionLine /></div>
    if (scene === 'welcome') return <StorefrontWelcome storefront={STOREFRONT} teacher={teacher.identity.publicKey} onStart={() => {}} />
    if (scene === 'long') return <SignReview encounter={long} alias="合成小王" previousPrescription={null} onSign={() => {}} onBack={() => {}} />
    if (scene === 'tongue') return <div className="nl-shell"><main className="nl-page"><TonguePair record={tongue} crop={cropped} editable title="舌象 1 · 辰时 · 霜降 · 北京" /></main></div>
    if (studentScene) return <StudentShell store={pagesStore} identity={pagesIdentity} llm={stubLlm} stack={stack} stackStatus="ready" modelSettings={modelSettingsNode} memberStore={pagesStore} memberIdentity={pagesIdentity} family={familyOptions} active={0} onSwitch={() => {}} sendEnvelope={async () => {}} />
    return <TeacherShell identity={teacher.identity} store={teacher.store} stack={stack} llm={stubLlm} gateway={gateway} status={status} settings={settingsNode} />
  }

  // Vite 冷启动可能让这个模块执行两次；同一个容器只建一个 React 根，否则整页切换时两个根互删节点。
  const holder = window as unknown as { __phoneRoot?: ReturnType<typeof createRoot> }
  holder.__phoneRoot ??= createRoot(document.getElementById('root')!)
  holder.__phoneRoot.render(<Scene />)
  Object.assign(window, { __phone: { student: student.publicKey, teacher: teacher.identity.publicKey, roster, intake: intakeControl } })
}

await main()
