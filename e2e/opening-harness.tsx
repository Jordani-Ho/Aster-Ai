import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { OpeningGuide } from '../app/src/OpeningGuide'
import { TeacherManagement } from '../app/src/TeacherManagement'
import { createIdentity } from '../app/src/core/identity'
import { openStore, resumeStore } from '../app/src/core/store'
import { loadPersonalModel, type PersonalModel } from '../app/src/core/llm/personal'
import { markHallOpened, loadGuide, saveGuide } from '../app/src/core/hall'
import { publishStorefront } from '../app/src/core/storefront'
import { rememberTeacherStudent } from '../app/src/core/records/teacher'
import { takeSetupToken } from '../app/src/core/setup-link'

// 和 App 一样：一次性口令在模块加载时取出并清掉地址栏（V2-31 / V2-37）。
const initialSetupToken = takeSetupToken()

// V2-17 建馆浏览器验收：真实组件 + fake 网关/模型路由，不连中继、不调真实模型。
// 场景：guide（五步引导）/ manage（开馆后的“我的馆”）。
const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'guide'
const NAME = params.get('name') ?? 'opening-' + scene

async function node() {
  const prior = await resumeStore({ name: NAME })
  if (prior) return prior
  const identity = createIdentity()
  return { identity, store: await openStore(identity, { name: NAME }) }
}

const session = await node()

if (scene === 'manage') {
  await markHallOpened(session.store)
  await publishStorefront({
    store: session.store, identity: session.identity,
    storefront: { name: '合成养生馆', displayName: '合成阿慈', emblem: 'leaf', theme: 'warm', intro: '一起照顾日常作息。', welcome: '从每天照镜子开始。' },
  })
  await rememberTeacherStudent(session.store, 'c'.repeat(64))
  createRoot(document.getElementById('root')!).render(<TeacherManagement
    identity={session.identity}
    store={session.store}
    llm={null}
    gateway="https://opening.synthetic.invalid"
    settings={<details><summary>模型与偏好设置</summary><p>合成设置</p></details>}
  />)
} else {
  function Harness() {
    const [modelConfig, setModelConfig] = useState<PersonalModel | null | undefined>(undefined)
    const [done, setDone] = useState(false)
    const [selected, setSelected] = useState<string | undefined>()
    useEffect(() => { let active = true; void loadPersonalModel(session.store).then(value => { if (active) setModelConfig(value) }).catch(() => { if (active) setModelConfig(null) }); return () => { active = false } }, [])
    if (done) return <main id="done"><h1>已进入老师首页</h1><p>{selected ?? "未开始面诊"}</p></main>
    return <OpeningGuide
      identity={session.identity}
      store={session.store}
      gateway="https://opening.synthetic.invalid"
      modelGateway={null}
      modelConfig={modelConfig}
      onModelSaved={model => setModelConfig(model)}
      onDone={student => { setSelected(student); setDone(true) }}
      setupToken={initialSetupToken}
    />
  }
  createRoot(document.getElementById('root')!).render(<Harness />)
}

Object.assign(window, {
  __opening: {
    failNextSave: () => {
      const put = session.store.put.bind(session.store)
      session.store.put = async () => { session.store.put = put; throw Error('SYNTHETIC_DISK_FULL') }
    },
    addFirstStudent: async () => {
      await rememberTeacherStudent(session.store, 'a'.repeat(64))
      window.dispatchEvent(new Event('aster:data-changed'))
    },
    finishBasics: async () => {
      await session.store.put('teacher-student-basics', 'a'.repeat(64), { alias: '合成小明', gender:'other', age:30, bazi:null, city:'北京市', at:100 })
      window.dispatchEvent(new Event('aster:data-changed'))
    },
    expireInvite: async () => {
      const guide = await loadGuide(session.store)
      if (!guide.firstInvite) throw new Error('还没有第一位邀请')
      // 保持 createdAt < expiresAt 才能被 normalizer 接受，同时一定已经过期。
      await saveGuide(session.store, { step: 5, firstInvite: { ...guide.firstInvite, expiresAt: guide.firstInvite.createdAt + 1 } })
    },
    link: async () => (await loadGuide(session.store)).firstInvite?.link ?? '',
  },
})
