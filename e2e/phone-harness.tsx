import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TeacherWorkspace } from '../app/src/TeacherWorkspace'
import { TeacherInboxPage } from '../app/src/TeacherInboxPage'
import { InPersonPage } from '../app/src/InPersonPage'
import { TeacherManagement } from '../app/src/TeacherManagement'
import { LedgerSettings } from '../app/src/LedgerSettings'
import { SignEncounterPage } from '../app/src/SignEncounterPage'
import { TonguePair } from '../app/src/TonguePair'
import { OpeningGuide } from '../app/src/OpeningGuide'
import { CommunityDashboard } from '../app/src/CommunityDashboard'
import { createIdentity } from '../app/src/core/identity'
import { openStore, resumeStore } from '../app/src/core/store'
import { createLedgerSync } from '../app/src/core/ledger/sync'
import { startInPersonEncounter } from '../app/src/core/record/in-person'
import { markHallOpened, saveGuide } from '../app/src/core/hall'
import { publishStorefront } from '../app/src/core/storefront'
import { rememberTeacherStudent } from '../app/src/core/records/teacher'
import type { PersonalModel } from '../app/src/core/llm/personal'
import type { TongueAbstract } from '../../domain/tcm/tongue'
import type { Encounter } from '../app/src/core/record/types'

// V2-13 老师端手机化浏览器验收：真实组件 + 合成数据；不连中继、不调真实模型。
// 场景：today / remote / in-person / manage / opening。
const scene = new URLSearchParams(location.search).get('scene') ?? 'today'
const send = async () => 'synthetic-envelope'
const gateway = 'https://phone.synthetic.invalid'

async function node(name: string) {
  const prior = await resumeStore({ name })
  if (prior) return prior
  const identity = createIdentity()
  return { identity, store: await openStore(identity, { name }) }
}

const teacher = await node('phone-teacher-' + scene)
const student = createIdentity()
await teacher.store.put('settings', 'role', { role: 'teacher' })
// 建馆场景故意不预置学生，才能测“先进去看看”；其他老师页都需要一个合成学生。
if (scene !== 'opening') await rememberTeacherStudent(teacher.store, student.publicKey)
if (!(await teacher.store.get('settings', 'hall'))) {
  await markHallOpened(teacher.store)
  await publishStorefront({
    store: teacher.store, identity: teacher.identity,
    storefront: { name: '合成养生馆', displayName: '合成阿慈', emblem: 'leaf', theme: 'warm', intro: '一起照顾日常作息。', welcome: '从每天照镜子开始。' },
  })
}

const ledger = createLedgerSync({
  identity: teacher.identity, store: teacher.store,
  onChange: () => window.dispatchEvent(new Event('aster:data-changed')),
  send: async () => crypto.randomUUID(),
})

function baseEncounter(long = false): Encounter {
  const encounter = startInPersonEncounter({ teacher: teacher.identity.publicKey, student: student.publicKey, id: 'a'.repeat(32), now: new Date('2026-10-20T12:00:00.000Z') })
  encounter.kind = 'remote_async'
  encounter.intake.chiefComplaint = { value: '最近睡不好', source: 'student' }
  encounter.intake.presentIllness = { value: long ? '夜里容易醒，白天没精神。'.repeat(120) : '夜里容易醒，白天没精神。', source: 'student' }
  encounter.intake.history = { value: '去年有过一次胃不舒服。', source: 'student' }
  encounter.fourExams.look = { value: '面色偏黄', source: 'teacher' }
  encounter.judgment.pattern = { value: '心脾两虚', source: 'ai_draft' }
  encounter.plan.principle = { value: '健脾养心', source: 'teacher' }
  encounter.plan.prescription = { value: { items: [{ herb: '合成药材', dose: '6g' }], method: '水煎服', days: 7 }, source: 'teacher' }
  encounter.plan.advice = { value: '早点休息，少吃生冷。', source: 'teacher' }
  encounter.plan.homework = [{ id: 'b'.repeat(32), title: '睡前泡脚', detail: '温水泡到微微出汗。', schedule: { kind: 'daily', time: '21:00' }, durationDays: 7, source: 'teacher' }]
  encounter.outcome = {
    change: { value: '睡得沉一些', source: 'teacher' },
    adverse: { value: '没发现', source: 'teacher' },
    next: { value: '两周后复诊', source: 'teacher' },
  }
  return encounter
}

if (scene === 'remote') {
  const encounter = baseEncounter()
  await teacher.store.put('consult-package', encounter.id, {
    encounter, history: [], attachments: [], receivedAt: new Date('2026-10-20T12:05:00.000Z').toISOString(), sender: student.publicKey, droppedHistory: 0,
  })
}
if (scene === 'long') {
  // 用长病历展示分段折叠和签字页。
}

const mirror = <p>我的镜子（合成）</p>
const settingsNode = <details><summary>设置</summary><p>合成设置</p></details>
const ledgerPanel = <LedgerSettings managed flat identity={teacher.identity} store={teacher.store} ledger={ledger} />
const status = <p role="status">中继：已连接</p>

function OpeningScene() {
  const [done, setDone] = useState(false)
  if (done) return <main id="phone-done"><h1>已进入老师首页</h1></main>
  return <OpeningGuide identity={teacher.identity} store={teacher.store} gateway={gateway} modelGateway={null} modelConfig={{ provider: 'other', baseUrl: 'https://model.synthetic.invalid/v1', model: 'synthetic', apiKey: 'SYNTHETIC', testedAt: new Date().toISOString() }} onModelSaved={() => {}} onDone={() => setDone(true)} />
}

async function tongueCrop(): Promise<Uint8Array> {
  const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 240
  const context = canvas.getContext('2d')!
  context.fillStyle = '#d98f9a'; context.fillRect(0, 0, 240, 240)
  context.fillStyle = '#b46a78'; context.beginPath(); context.ellipse(120, 130, 60, 80, 0, 0, Math.PI * 2); context.fill()
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8))
  return new Uint8Array(await blob!.arrayBuffer())
}

if (scene === 'opening') {
  await markHallOpened(teacher.store)
  await saveGuide(teacher.store, { step: 5, firstInvite: { link: 'https://phone.synthetic.invalid/#invite=synthetic', createdAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
}
const tongue: TongueAbstract = {
  kind: 'tongue',
  features: { color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.8 },
  svg: '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="#f3f1ec"/><ellipse cx="50" cy="55" rx="22" ry="30" fill="#d98f9a"/></svg>',
  shichen: '辰', jieqi: '霜降', city: '北京',
}
const crop = await tongueCrop()

function Scene() {
  const shell = (content: React.ReactNode) => <div className="teacher-shell"><div className="teacher-content">{content}</div></div>
  if (scene === 'opening') return <OpeningScene />
  if (scene === 'dashboard') return <CommunityDashboard relays={[]} />
  if (scene === 'today') return <TeacherWorkspace identity={teacher.identity} store={teacher.store} stack={null} llm={null} gateway={gateway} status={status} ledgerPanel={ledgerPanel} settings={settingsNode} mirror={mirror} />
  if (scene === 'remote') return shell(<TeacherInboxPage identity={teacher.identity} store={teacher.store} send={send} llm={null} onBack={() => {}} />)
  if (scene === 'in-person') return shell(<InPersonPage identity={teacher.identity} store={teacher.store} llm={null} onBack={() => {}} />)
  if (scene === 'manage' || scene === 'storefront' || scene === 'ledger' || scene === 'reidentify') return shell(<TeacherManagement identity={teacher.identity} store={teacher.store} llm={null} gateway={gateway} send={send} ledgerPanel={ledgerPanel} settings={settingsNode} />)
  if (scene === 'long') return shell(<SignEncounterPage initial={baseEncounter(true)} onConfirm={() => {}} onCancel={() => {}} onRevise={async next => next} comparison={null} onComparisonChange={() => {}} />)
  if (scene === 'tongue') return shell(<main><TonguePair record={tongue} crop={crop} editable title="舌象 1 · 辰时 · 霜降 · 北京" /></main>)
  return shell(<p>未知场景</p>)
}

createRoot(document.getElementById('root')!).render(<Scene />)
Object.assign(window, { __phone: { student: student.publicKey, ledger } })
