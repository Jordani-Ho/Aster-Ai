import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TeacherShell } from '../app/src/TeacherShell'
import { StudentShell } from '../app/src/StudentShell'
import { SignReview } from '../app/src/SignReview'
import { TonguePair } from '../app/src/TonguePair'
import { OpeningGuide } from '../app/src/OpeningGuide'
import { CommunityDashboard } from '../app/src/CommunityDashboard'
import { LedgerSettings } from '../app/src/LedgerSettings'
import { createIdentity } from '../app/src/core/identity'
import { openStore, resumeStore } from '../app/src/core/store'
import { createLedgerSync } from '../app/src/core/ledger/sync'
import { startInPersonEncounter } from '../app/src/core/record/in-person'
import { markHallOpened, saveGuide } from '../app/src/core/hall'
import { publishStorefront } from '../app/src/core/storefront'
import { rememberTeacherStudent } from '../app/src/core/records/teacher'
import { addTeacher } from '../app/src/core/inbox'
import { saveTongue } from '../app/src/core/tongue'
import { loadProfile, saveProfile } from '../app/src/core/intake/session'
import type { LlmClient } from '../app/src/core/llm'
import type { Wiring } from '../app/src/core/wiring'
import type { TongueAbstract } from '../domain/tcm/tongue'
import type { Encounter } from '../app/src/core/record/types'

// V2-16 新界面浏览器验收：真实组件 + 合成数据；不连中继、不调真实模型。
// 场景：today / visit / student / manage / long / opening / dashboard / tongue。
const scene = new URLSearchParams(location.search).get('scene') ?? 'today'
const gateway = 'https://phone.synthetic.invalid'

async function node(name: string) {
  const prior = await resumeStore({ name })
  if (prior) return prior
  const identity = createIdentity()
  return { identity, store: await openStore(identity, { name }) }
}

// 模型替身：按提示词区分“拆四诊”和“起草病历”，按原话返回合成内容。
const stubLlm: LlmClient = {
  complete: async messages => {
    const system = String(messages[0]?.content ?? '')
    if (system.includes('面诊口述拆分四诊')) return JSON.stringify({ look: ['舌淡红，苔薄白'], listenSmell: [], ask: ['入睡难'], pulse: ['脉细弱'] })
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

const teacher = await node('v216-teacher-' + scene)
const student = createIdentity()
await teacher.store.put('settings', 'role', { role: 'teacher' })
// 建馆场景故意不预置学生；其他场景都需要一位合成学生。
if (scene !== 'opening') await rememberTeacherStudent(teacher.store, student.publicKey)
if (!(await teacher.store.get('settings', 'hall'))) {
  await markHallOpened(teacher.store)
  await publishStorefront({ store: teacher.store, identity: teacher.identity, storefront: { name: '合成养生馆', displayName: '合成阿慈', emblem: 'leaf', theme: 'warm', intro: '一起照顾日常作息。', welcome: '从每天照镜子开始。' } })
}

const ledger = createLedgerSync({ identity: teacher.identity, store: teacher.store, onChange: () => window.dispatchEvent(new Event('aster:data-changed')), send: async () => crypto.randomUUID() })
const stack = {
  send: async () => 'synthetic-envelope',
  sendConsult: async () => {},
  ledger,
  flushIntakeOutbox: async () => 0,
  close: async () => {},
} as unknown as Wiring
const settingsNode = <details><summary>设置</summary><p>合成设置</p></details>
const ledgerPanel = <LedgerSettings managed flat identity={teacher.identity} store={teacher.store} ledger={ledger} />
const status = <><p role="status">中继：已连接</p></>
const now = new Date()
const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')

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
  await teacher.store.put('consult-package', 'a'.repeat(32), {
    encounter: remoteEncounter(), history: [], attachments: [],
    receivedAt: new Date('2026-10-22T02:05:00.000Z').toISOString(), sender: student.publicKey, droppedHistory: 0,
  })
  await teacher.store.put('student-adherence', student.publicKey, {
    student: student.publicKey, weekStart: today, weeklyRate: 0.3, streak: 0, practiceDays: 2, scheduled: 7, done: 2,
    receivedAt: new Date().toISOString(),
  })
}

async function seedStudent() {
  await addTeacher(teacher.store, teacher.identity.publicKey)
  const profile = await loadProfile(teacher.store)
  await saveProfile(teacher.store, { ...profile, alias: { value: '合成小王', source: 'student' }, city: { value: '北京市', source: 'student' } })
  await teacher.store.put('care-plans', teacher.identity.publicKey, {
    constitution: '平和质', points: ['霜降养脾胃。早饭吃温热的，别空腹喝冷饮。'], avoid: ['生冷'], updatedAt: new Date().toISOString(), version: 1,
  })
  const first = { id: 'c'.repeat(32), title: '泡脚十五分钟', detail: '水温到微微出汗。', schedule: { kind: 'daily' as const, time: '21:00' }, durationDays: 7, source: 'teacher' as const }
  const second = { id: 'd'.repeat(32), title: '按揉神门穴', detail: '每次两分钟。', schedule: { kind: 'habit' as const, anchor: '躺下后' }, durationDays: 7, source: 'teacher' as const }
  await teacher.store.put('homework', first.id, { homework: first, startsOn: today })
  await teacher.store.put('homework', second.id, { homework: second, startsOn: today })
  await teacher.store.put('checkins', crypto.randomUUID(), { homeworkId: second.id, at: new Date().toISOString() })
  const features = { color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.8 }
  const { tongueSvg } = await import('../domain/tcm/tongue')
  const crop = await tongueCrop()
  const record: TongueAbstract = { kind: 'tongue', features, svg: tongueSvg(features), shichen: '辰', jieqi: '霜降', city: '北京', crop: { id: 'e'.repeat(32), type: 'photo', sha256: 'f'.repeat(64), bytes: crop.length } }
  await saveTongue(teacher.store, record, new Date(Date.now() - 86400000), crop)
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

function OpeningScene() {
  const [done, setDone] = useState(false)
  if (done) return <main id="phone-done"><h1>已进入老师首页</h1></main>
  return <OpeningGuide identity={teacher.identity} store={teacher.store} gateway={gateway} modelGateway={null} modelConfig={{ provider: 'other', baseUrl: 'https://model.synthetic.invalid/v1', model: 'synthetic', apiKey: 'SYNTHETIC', testedAt: new Date().toISOString() }} onModelSaved={() => {}} onDone={() => setDone(true)} />
}

async function main() {
  if (scene === 'opening') {
    await markHallOpened(teacher.store)
    await saveGuide(teacher.store, { step: 5, firstInvite: { link: 'https://phone.synthetic.invalid/#invite=synthetic', createdAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
  }
  if (scene === 'today' || scene === 'manage' || scene === 'visit') await seedRemote()
  if (scene === 'student') await seedStudent()

  const cropped = await tongueCrop()
  const tongueFeatures = { color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.8 }
  const { tongueSvg } = await import('../domain/tcm/tongue')
  const tongue: TongueAbstract = { kind: 'tongue', features: tongueFeatures, svg: tongueSvg(tongueFeatures), shichen: '辰', jieqi: '霜降', city: '北京' }
  const long = longEncounter()

  function Scene() {
    if (scene === 'opening') return <OpeningScene />
    if (scene === 'dashboard') return <CommunityDashboard relays={[]} />
    if (scene === 'student') return <StudentShell store={teacher.store} identity={teacher.identity} llm={stubLlm} stack={null} stackStatus="ready" memberStore={teacher.store} memberIdentity={teacher.identity} />
    if (scene === 'long') return <SignReview encounter={long} alias="合成小王" previousPrescription={null} onSign={() => {}} onBack={() => {}} />
    if (scene === 'tongue') return <div className="nl-shell"><main className="nl-page"><TonguePair record={tongue} crop={cropped} editable title="舌象 1 · 辰时 · 霜降 · 北京" /></main></div>
    return <TeacherShell identity={teacher.identity} store={teacher.store} stack={stack} llm={stubLlm} gateway={gateway} status={status} ledgerPanel={ledgerPanel} settings={settingsNode} />
  }

  createRoot(document.getElementById('root')!).render(<Scene />)
  Object.assign(window, { __phone: { student: student.publicKey, teacher: teacher.identity.publicKey } })
}

await main()
