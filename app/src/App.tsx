import { PilotSettings } from './PilotSettings'
import {createPersonalClient, loadPersonalModel, type PersonalModel} from './core/llm/personal'
import {ModelSettings} from './ModelSettings'
import {InviteSettings} from './InviteSettings'
import { LedgerSettings } from './LedgerSettings'
import './homework.css'
import { lazy, Suspense, useEffect, useRef, useState, useMemo } from 'react'
import { PushSettings } from './PushSettings'

import type { Identity } from './core/identity'
import { bootstrapIdentity, readInviteLink, acceptInvite, gatewayBase, INVITE_ERROR } from './core/onboarding'
import type { LocalStore } from './core/store'
import { createWiring, type Wiring } from './core/wiring'
import { createPushClient } from './core/push'
import { TeacherListSettings } from './TeacherListSettings'
import { StudentShell } from './StudentShell'
import { loadFamilyMembers, memberIdentity, memberStore, type FamilyMember } from './core/family'

const TeacherWorkspace = lazy(() => import('./TeacherWorkspace').then(module => ({default:module.TeacherWorkspace})))

type Role = 'student' | 'teacher'
type LinkStatus = 'offline' | 'connecting' | 'ready' | 'rejected' | 'invalid-message'
const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
const defaultRelays = (env.VITE_COMMUNITY_RELAYS ?? '').split(',').map(value => value.trim()).filter(Boolean)
// 部署时配置这两个变量，发送成功后才会调用 M1-08 的 notifyRecipient；没配置就不提醒，不影响发送。
const pushGatewayUrl = env.VITE_PUSH_GATEWAY_URL ?? ''
const pushVapidPublicKey = env.VITE_PUSH_VAPID_PUBLIC_KEY ?? ''

const gateway = gatewayBase(env.VITE_MODEL_GATEWAY_URL ?? pushGatewayUrl)

export function App() {
  const [modelConfig,setModelConfig]=useState<PersonalModel|null|undefined>(undefined)
  const [backupModel,setBackupModel]=useState(false)
  const [role, setRole] = useState<Role | null>(null)
  // M1-22 家人子账户：家人清单、当前在看谁（0 = 本人），以及每位家人的中继连接。
  const [family, setFamily] = useState<FamilyMember[]>([])
  const [active, setActive] = useState(0)
  const [memberStacks, setMemberStacks] = useState<ReadonlyMap<number, Wiring>>(new Map())
  const [memberStatus, setMemberStatus] = useState<Record<number, LinkStatus>>({})
  const [stackStatus, setStackStatus] = useState<LinkStatus>('offline')
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const storeRef = useRef<LocalStore | null>(null)
  const identityRef = useRef<Identity | null>(null)
  const stackRef = useRef<Wiring | null>(null)

  useEffect(() => {
    let cancelled = false
    void bootstrapIdentity().then(async session => {
      if (cancelled) { session.store.close(); session.identity.privateKey.fill(0); return }
      const {store,identity: person}=session
      storeRef.current=store;identityRef.current=person
      try {
        const invitation=readInviteLink(location.href)
        if(invitation){await acceptInvite(person,store,invitation,gateway+'/invite/redeem');history.replaceState(null,'',location.pathname+location.search)}
      } catch (cause) {setError(cause instanceof Error&&cause.message===INVITE_ERROR?INVITE_ERROR:'暂时未能加入社区，请稍后重新打开邀请。')}
      if(cancelled){store.close();person.privateKey.fill(0);return}
      const saved=await store.get('settings','role') as {role?:Role}|undefined
      setRole(saved?.role??null);setIdentity(person)
      void loadFamilyMembers(store).then(rows => { if (!cancelled) setFamily(rows) }).catch(() => {})
    }).catch(() => { if(!cancelled) setError('本机资料暂时无法打开，请稍后重试。') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; stackRef.current?.close(); stackRef.current = null; storeRef.current?.close(); storeRef.current = null; identityRef.current?.privateKey.fill(0); identityRef.current = null }
  }, [])

  useEffect(()=>{
    if(!identity||!storeRef.current)return
    let cancelled=false;setBackupModel(false)
    void loadPersonalModel(storeRef.current).then(c=>{if(!cancelled)setModelConfig(c)}).catch(()=>{if(!cancelled)setModelConfig(null)})
    return()=>{cancelled=true}
  },[identity])

  // M1-15a：一个 transport + 收件分发 + 账本同步；有中继配置才启动。
  // M1-22：每位家人各起一个自己的中继连接（各自订阅、各自解密），账本仍只在本人这条连接上。
  useEffect(() => {
    if (!identity || !storeRef.current) return
    const store = storeRef.current
    let cancelled = false
    const opened: Wiring[] = []
    void (async () => {
      const relays = defaultRelays
      if (cancelled || relays.length === 0) return
      const notifier = async (pubkey: string) => {
        if (!pushGatewayUrl || !pushVapidPublicKey) return
        const client = createPushClient({ gatewayUrl: pushGatewayUrl, vapidPublicKey: pushVapidPublicKey, secretKey: identity.privateKey })
        await client.notifyRecipient(pubkey)
      }
      const start = (who: Identity, scoped: LocalStore, report: (status: LinkStatus) => void) => {
        const stack = createWiring({
          identity: who, store: scoped, relays,
          onChange: () => window.dispatchEvent(new Event('aster:data-changed')),
          onStatus: status => { if (!cancelled) report(status as LinkStatus) },
          onError: () => { if (!cancelled) report('offline') },
          notifier,
        })
        opened.push(stack)
        stack.start()
        // M1-05 接通后，把本机待发的替身问诊包真实发出，成功后删除。
        void stack.flushIntakeOutbox().catch(() => {})
        return stack
      }
      const stack = start(identity, store, status => setStackStatus(status))
      stackRef.current = stack
      const members = new Map<number, Wiring>()
      for (const member of family) {
        const who = memberIdentity(member)
        members.set(member.account, start(who, memberStore(store, member.account), status => {
          if (!cancelled) setMemberStatus(previous => ({ ...previous, [member.account]: status }))
        }))
      }
      if (!cancelled) setMemberStacks(members)
    })().catch(() => {})
    return () => {
      cancelled = true
      stackRef.current = null
      for (const stack of opened) void stack.close()
      setMemberStacks(new Map())
      setMemberStatus({})
    }
  }, [identity, family])

  const chooseRole = async (next: Role) => {
    setError('')
    setRole(next)
    try { if (storeRef.current) await storeRef.current.put('settings', 'role', { role: next }) }
    catch { setError('角色没有保存成功，请重试。') }
  }

  // 家人被移除后，当前查看的家人切回本人。
  useEffect(() => {
    if (active !== 0 && !family.some(member => member.account === active)) setActive(0)
  }, [family, active])

  const store = storeRef.current
  const stack = stackRef.current
  const activeMember = family.find(member => member.account === active) ?? null
  const activeStore = store ? (activeMember ? memberStore(store, activeMember.account) : store) : null
  const activeIdentity = useMemo(() => activeMember ? memberIdentity(activeMember) : identity, [identity, activeMember])
  const activeStack = activeMember ? memberStacks.get(activeMember.account) ?? null : stack
  const activeStatus: LinkStatus = activeMember ? memberStatus[activeMember.account] ?? 'offline' : stackStatus
  const memberOptions = family.map(member => ({ account: member.account, alias: member.alias }))
  const refreshFamily = () => { if (storeRef.current) void loadFamilyMembers(storeRef.current).then(setFamily).catch(() => {}) }
  const modelGateway=useMemo(()=>identity&&env.VITE_MODEL_GATEWAY_URL?{baseUrl:env.VITE_MODEL_GATEWAY_URL,secretKey:identity.privateKey}:null,[identity])
  const llm=useMemo(()=>modelConfig?createPersonalClient(modelConfig,modelGateway,setBackupModel):null,[modelConfig,modelGateway])
  const modelNotice=<>{backupModel&&<p role="status" style={{fontSize:12}}>今天用的是备用模型，请检查您的模型账户</p>}</>
  const modelSettings=store?<details><summary>我的大模型</summary><ModelSettings key={modelConfig?.testedAt??'new'} store={store} gateway={modelGateway} current={modelConfig??null} onSaved={config=>setModelConfig(config)}/></details>:null
  if(identity&&role&&store&&!modelConfig)return <main style={{fontFamily:'system-ui',padding:16,maxWidth:480,margin:'0 auto'}}><h1>知衡</h1>{modelNotice}{modelConfig===undefined?<p>正在读取接入设置…</p>:<><ModelSettings initial store={store} gateway={modelGateway} current={null} onSaved={setModelConfig}/>{role==='teacher'&&<details><summary>社区首次登记</summary><InviteSettings identity={identity} gateway={gateway}/></details>}</>}</main>
  // 学生端三个底部标签（镜子/问诊/其他）；老师端走 TeacherWorkspace 四页。模型由 M1-21 的 personal client 提供。
  // M1-22：学生壳用“当前家人”的分片存储与身份，设置区仍用根身份；家人切换在镜子页/问诊页顶部。
  if (store && identity && role === 'student') return <StudentShell store={store} identity={identity} llm={llm} stack={stack} stackStatus={activeStatus} modelNotice={modelNotice} modelSettings={modelSettings} family={memberOptions} active={active} onSwitch={setActive} memberStore={activeStore ?? store} memberIdentity={activeIdentity ?? identity} sendConsult={activeStack?.sendConsult} sendEnvelope={activeStack?.send} onFamilyChanged={refreshFamily} />
  if (role==='teacher' && store && identity) return <Suspense fallback={<p>正在打开老师工作台…</p>}><TeacherWorkspace identity={identity} store={store} stack={stack} llm={llm} gateway={gateway} status={<>{modelNotice}<p role="status">中继：{stackStatus==='ready'?'已连接':stackStatus==='connecting'?'正在连接':'尚未连接'}</p></>} ledgerPanel={<LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus}/>} settings={<details><summary>设置</summary>
      <details><summary>调整使用角色</summary><button disabled={role==='teacher'} onClick={()=>void chooseRole('teacher')}>我是老师</button><button onClick={()=>void chooseRole('student')}>我是学生</button></details>
      {modelSettings}<TeacherListSettings store={store}/><PilotSettings store={store}/>
      <details><summary>社区首次登记</summary><InviteSettings identity={identity} gateway={gateway}/></details>
      <PushSettings identity={identity}/>
    </details>} /></Suspense>
  return <main style={{fontFamily:'system-ui, sans-serif',padding:'24px 16px',maxWidth:480,margin:'0 auto'}}>
    <h1>知衡</h1>{modelNotice}
    {loading&&<p>正在准备…</p>}{error&&<p role="alert">{error}</p>}
    {!loading&&identity&&!role&&<section><h2>您是老师还是学生？</h2><button onClick={()=>void chooseRole('teacher')}>我是老师</button>{' '}<button onClick={()=>void chooseRole('student')}>我是学生</button></section>}
    {store&&identity&&<details><summary>设置</summary>
      <details><summary>调整使用角色</summary><button disabled={role==='teacher'} onClick={()=>void chooseRole('teacher')}>我是老师</button><button disabled={role==='student'} onClick={()=>void chooseRole('student')}>我是学生</button></details>
      {modelSettings}<TeacherListSettings store={store}/>{role==='teacher'&&<PilotSettings store={store}/>}
      <LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} members={memberOptions}/>
      <PushSettings identity={identity}/>
    </details>}
  </main>
}
