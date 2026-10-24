import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StorefrontWelcome } from '../app/src/StorefrontWelcome'
import { StorefrontSettings } from '../app/src/StorefrontSettings'
import { StudentShell } from '../app/src/StudentShell'
import { openStore, resumeStore } from '../app/src/core/store'
import { createIdentity } from '../app/src/core/identity'
import { addTeacher } from '../app/src/core/inbox'
import { saveBasics } from '../app/src/core/basics'
import { saveTeacherLabel } from '../app/src/core/identity/teacher-labels'
import { loadCachedStorefront, loadOwnStorefront, makeStorefrontEvent, publishStorefront, saveReceivedStorefront, type Storefront } from '../app/src/core/storefront'
import { saveActiveTeacher } from '../app/src/core/storefront/active'

// V2-09 门面浏览器验收：两份合成配置（阿慈养生馆 / 小黄运动馆）各出一次邀请首屏，
// 再用真实 StorefrontSettings 走“改 → 预览 → 用这个样子 → 恢复上次样子”，最后用真实 StudentShell
// 验证两位老师之间切换：门牌、问诊收件人和钱账一起切。全部合成数据，不连中继。
const ACI: Storefront = { name: '阿慈养生馆', displayName: '阿慈', emblem: 'leaf', theme: 'warm', intro: '一起照顾日常作息，慢慢练成适合自己的习惯。', welcome: '从每天照镜子开始。' }
const HUANG: Storefront = { name: '小黄运动馆', displayName: '小黄', emblem: 'sun', theme: 'cool', intro: '每天动一动，练完记录一下。', welcome: '今天先来十分钟。' }

async function node(name: string) {
  const prior = await resumeStore({ name })
  if (prior) return prior
  const identity = createIdentity()
  return { identity, store: await openStore(identity, { name }) }
}

const aci = await node('storefront-aci')
const huang = await node('storefront-huang')
const student = await node('storefront-student')
// 老师 A 先生成过一版，供“恢复上次样子”使用。
if (!(await loadOwnStorefront(aci.store, aci.identity)).current) {
  await publishStorefront({ store: aci.store, identity: aci.identity, storefront: ACI, now: new Date('2026-10-18T09:00:00.000Z') })
}
// 学生跟两位老师：门面缓存、称呼与默认馆都按真实链路写入本机。
await addTeacher(student.store, aci.identity.publicKey)
await addTeacher(student.store, huang.identity.publicKey)
// V2-23：已在用的学生，基础信息已填好。
await saveBasics(student.store, { alias: '合成小王', gender: 'male', birthDate: '1990-05-06', city: '北京市' })
await student.store.put('settings', 'role', { role: 'student' })
if (!(await loadCachedStorefront(student.store, aci.identity.publicKey))) {
  await saveReceivedStorefront(student.store, makeStorefrontEvent(aci.identity, ACI, 1000), aci.identity.publicKey)
  await saveReceivedStorefront(student.store, makeStorefrontEvent(huang.identity, HUANG, 1000), huang.identity.publicKey)
  await saveTeacherLabel(student.store, aci.identity.publicKey, '阿慈')
  await saveTeacherLabel(student.store, huang.identity.publicKey, '小黄')
  await saveActiveTeacher(student.store, aci.identity.publicKey, [aci.identity.publicKey, huang.identity.publicKey])
}

function Harness() {
  const [view, setView] = useState<'aci' | 'huang' | 'teacher' | 'student'>('aci')
  return <>
    <nav style={{ display: 'flex', gap: 8, padding: 8 }}>
      <button onClick={() => setView('aci')}>阿慈邀请</button>
      <button onClick={() => setView('huang')}>小黄邀请</button>
      <button onClick={() => setView('teacher')}>老师的门面</button>
      <button onClick={() => setView('student')}>学生切换老师</button>
    </nav>
    {view === 'teacher' && <StorefrontSettings identity={aci.identity} store={aci.store} llm={null} />}
    {view === 'student' && <StudentShell store={student.store} identity={student.identity} llm={null} stack={null} stackStatus="offline" memberStore={student.store} memberIdentity={student.identity} />}
    {(view === 'aci' || view === 'huang') && <StorefrontWelcome storefront={view === 'aci' ? ACI : HUANG} teacher={(view === 'aci' ? aci.identity : huang.identity).publicKey} onStart={() => {}} />}
  </>
}

Object.assign(window, {
  storefrontState: async () => {
    const own = await loadOwnStorefront(aci.store, aci.identity)
    return {
      teachers: [aci.identity.publicKey, huang.identity.publicKey],
      own: own.current ? JSON.parse(own.current.content).storefront : null,
      previous: own.previous ? JSON.parse(own.previous.content).storefront : null,
    }
  },
})

createRoot(document.getElementById('root')!).render(<Harness />)
