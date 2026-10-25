import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import template from '../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../domain/tcm/templates/types'
import type { Envelope } from '../app/src/core/transport'
import { createIdentity, type Identity } from '../app/src/core/identity'
import { openStore, type LocalStore } from '../app/src/core/store'
import { createWiring } from '../app/src/core/wiring'
import { ConsultPage } from '../app/src/ConsultPage'
import { RemoteReview } from '../app/src/RemoteReview'
import { StudentRecordsPage } from '../app/src/StudentRecordsPage'
import { listConsults, sendConsultPackage, type StoredConsult } from '../app/src/core/inbox'
import {
  emptyProfile, markReviewed, organizeSession, saveDraft, saveProfile, skipFocus, startSession,
} from '../app/src/core/intake'
import { loadDefaultPostureMetrics, savePostureMetrics } from '../app/src/core/posture'
import type { ConsultPackage } from '../app/src/core/record/types'

// V2-32 浏览器验收：学生在家拍体态 → 问诊包 → 老师远程核对（老师自己的指标）→ 签字交还 → 学生记录页。
// 只用合成身份、合成图与可注入的骨骼检测器桩；老师端指标是自己加的“左右膝高低差”。
type IdentityNode = ReturnType<typeof createWiring>

const teacher = createIdentity()
const student = createIdentity()
const member = createIdentity()
const manager = createIdentity()
const optionalStudent = createIdentity()

const teacherStore = await openStore(teacher, { name: 'v232-teacher' })
const studentStore = await openStore(student, { name: 'v232-student' })
const memberStore = await openStore(member, { name: 'v232-member' })
const optionalStore = await openStore(optionalStudent, { name: 'v232-optional' })

const nodes = new Map<string, IdentityNode>()
function register(identity: Identity, store: LocalStore): IdentityNode {
  const wiring = createWiring({ identity, store, relays: ['ws://localhost/'] })
  nodes.set(identity.publicKey, wiring)
  return wiring
}
register(teacher, teacherStore)
register(student, studentStore)
register(member, memberStore)
register(optionalStudent, optionalStore)

// 内存中继替身：把信封直接投进收件人的 inbox（与真实中继相同的 receive 校验路径）。
async function deliver(sender: string, recipient: string, envelope: Envelope): Promise<void> {
  const target = nodes.get(recipient)
  if (!target) throw new Error('没有这个收件人：' + recipient.slice(0, 8))
  await target.inbox.receive({ id: crypto.randomUUID(), sender, at: Math.floor(Date.now() / 1000), envelope })
}

let lastPackage: ConsultPackage | null = null
async function sendConsultFrom(identity: Identity, store: LocalStore, pkg: ConsultPackage): Promise<void> {
  lastPackage = pkg
  await sendConsultPackage((to, envelope) => deliver(identity.publicKey, to, envelope), pkg, { store })
}

async function seedDraft(identity: Identity, store: LocalStore): Promise<void> {
  let state = startSession({ student: identity.publicKey, teacher: teacher.publicKey, template: template as TeacherTemplate })
  let guard = 0
  while (state.phase === 'collecting' && guard < 12) {
    state = await organizeSession(state, null)
    for (const question of [...state.questions]) state = skipFocus(state, question.focus)
    guard += 1
  }
  await saveDraft(store, markReviewed(state))
}

await seedDraft(student, studentStore)
await seedDraft(optionalStudent, optionalStore)
await seedDraft(member, memberStore)
await saveProfile(studentStore, { ...emptyProfile(), alias: { value: '本人', source: 'student' } })
await saveProfile(memberStore, {
  ...emptyProfile(),
  alias: { value: '妈妈', source: 'student' },
  managedBy: { value: '我', source: 'student' },
})
// 老师自己定的指标：默认四条 + “左右膝高低差”（学生端看不到、老师端核对页要算出来）。
await savePostureMetrics(teacherStore, [
  ...loadDefaultPostureMetrics(),
  { id: 'knee-gap', name: '左右膝高低差', formula: 'heightDiff(left_knee, right_knee)', unit: '%' },
])

const points = {
  nose: { x: 0.5, y: 0.12, visibility: 0.95 },
  left_shoulder: { x: 0.4, y: 0.3, visibility: 0.95 }, right_shoulder: { x: 0.6, y: 0.32, visibility: 0.95 },
  left_hip: { x: 0.44, y: 0.55, visibility: 0.95 }, right_hip: { x: 0.56, y: 0.56, visibility: 0.95 },
  left_knee: { x: 0.44, y: 0.75, visibility: 0.95 }, right_knee: { x: 0.56, y: 0.78, visibility: 0.95 },
  left_ankle: { x: 0.44, y: 0.95, visibility: 0.95 }, right_ankle: { x: 0.56, y: 0.95, visibility: 0.95 },
}
;(globalThis as unknown as { __postureDetector: unknown }).__postureDetector = {
  async detect() { return { people: 1, points: structuredClone(points) } },
}

type Scene = 'student' | 'optional' | 'family' | 'teacher' | 'records' | 'family-records'

function Shell() {
  const [scene, setScene] = useState<Scene>('student')
  const [consult, setConsult] = useState<StoredConsult | null>(null)
  const open = async (next: Scene) => {
    if (next === 'teacher') {
      const rows = await listConsults(teacherStore)
      setConsult(rows[0] ?? null)
    }
    setScene(next)
    window.scrollTo(0, 0)
  }
  ;(globalThis as unknown as { __v232: unknown }).__v232 = {
    open,
    points,
    lastPackage: () => JSON.stringify(lastPackage),
    storeDump: async (which: 'student' | 'member' | 'teacher' | 'optional') => {
      const stores = { student: studentStore, member: memberStore, teacher: teacherStore, optional: optionalStore }
      const collections = { student: ['intake-draft', 'intake-sent', 'intake-attachments', 'student-records', 'profile'], member: ['intake-draft', 'intake-sent', 'intake-attachments', 'student-records', 'profile'], teacher: ['consult-package', 'teacher-records'], optional: ['intake-draft', 'intake-sent', 'student-records'] }
      const target = stores[which]
      const dump: Record<string, unknown[]> = {}
      for (const collection of collections[which]) dump[collection] = await target.list(collection)
      return JSON.stringify(dump)
    },
    consult: () => JSON.stringify(consult),
    identities: { teacher: teacher.publicKey, student: student.publicKey, member: member.publicKey, manager: manager.publicKey },
  }
  if (scene === 'student' || scene === 'optional' || scene === 'family') {
    const identity = scene === 'student' ? student : scene === 'optional' ? optionalStudent : member
    const store = scene === 'student' ? studentStore : scene === 'optional' ? optionalStore : memberStore
    return <div className="nl-shell">
      <ConsultPage store={store} modelStore={teacherStore} identity={identity} llm={null}
        sendConsult={pkg => sendConsultFrom(identity, store, pkg)}
        member={scene === 'family' ? { account: 1, alias: '妈妈' } : null}
        family={[]} active={0}
        managerIdentity={scene === 'family' ? manager : undefined}
        teacher={teacher.publicKey} teacherName="老师" onBack={() => {}} />
    </div>
  }
  if (scene === 'teacher') {
    return consult
      ? <RemoteReview identity={teacher} store={teacherStore} consult={consult} llm={null}
        send={(to, envelope) => deliver(teacher.publicKey, to, envelope)} onExit={() => {}} />
      : <div className="nl-shell"><main className="nl-page"><h1>还没有问诊</h1></main></div>
  }
  if (scene === 'records') return <StudentRecordsPage identity={student} store={studentStore} onBack={() => {}} />
  return <StudentRecordsPage identity={member} store={memberStore} onBack={() => {}} />
}

createRoot(document.getElementById('root')!).render(<Shell />)
