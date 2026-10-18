import { PasskeySettings, configuredRelays } from './PasskeySettings'
import { authenticatePasskey } from './core/onboarding/passkey'
import { recoverPasskey } from './core/onboarding/identity-relay'
import { PasskeyUnlockRequired, resumeStore, protectStore } from './core/store'
import { createBackupManager } from './core/backup'
import { communityBackupRelay } from './core/backup/relay'
import { PilotSettings } from './PilotSettings'
import {createPersonalClient, loadPersonalModel, type PersonalModel} from './core/llm/personal'
import {ModelSettings} from './ModelSettings'
import {InviteSettings} from './InviteSettings'
import { LedgerSettings } from './LedgerSettings'
import { BackupSettings } from './BackupSettings'
import './homework.css'
import { lazy, Suspense, useEffect, useRef, useState, useMemo } from 'react'
import { PushSettings } from './PushSettings'

import type { Identity } from './core/identity'
import { AdvancedRecovery } from './AdvancedRecovery'
import { bootstrapIdentity, readInviteLink, acceptInvite, gatewayBase, INVITE_ERROR } from './core/onboarding'
import { clearStore } from './core/store'
import { openStore, type LocalStore } from './core/store'
import { persistenceLabels, requestPersistence, type PersistenceStatus } from './core/store/persistence'
import { createWiring, type Wiring } from './core/wiring'
import { createPushClient } from './core/push'
import { TeacherListSettings } from './TeacherListSettings'
import { StudentShell } from './StudentShell'
import { loadFamilyMembers, memberIdentity, memberStore, type FamilyMember } from './core/family'

const TeacherWorkspace = lazy(() => import('./TeacherWorkspace').then(module => ({default:module.TeacherWorkspace})))
const HomeworkPage = lazy(() => import('./HomeworkPage').then(module => ({ default: module.HomeworkPage })))
const StudentRecordsPage = lazy(() => import('./StudentRecordsPage').then(module => ({ default: module.StudentRecordsPage })))

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
  const [restoreNotice,setRestoreNotice]=useState('')
  const [locked,setLocked]=useState(false),[recovering,setRecovering]=useState(false),[allowReplace,setAllowReplace]=useState(false)
  const [homeworkPage, setHomeworkPage] = useState(false)
  const [recordsPage, setRecordsPage] = useState(false)
  const [stackRevision, setStackRevision] = useState(0)
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
  const [persistence, setPersistence] = useState<PersistenceStatus>('requesting')
  const storeRef = useRef<LocalStore | null>(null)
  const identityRef = useRef<Identity | null>(null)
  const stackRef = useRef<Wiring | null>(null)

  useEffect(() => {
    let cancelled = false
    void requestPersistence(navigator.storage).then(status => { if (!cancelled) setPersistence(status) })
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
    }).catch(cause => { if(!cancelled){if(cause instanceof PasskeyUnlockRequired)setLocked(true);else setError('本机资料暂时无法打开，请使用恢复资料。')} })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; stackRef.current?.close(); stackRef.current = null; storeRef.current?.close(); storeRef.current = null; identityRef.current?.privateKey.fill(0); identityRef.current = null }
  }, [])

  // 按身份（老师 / 学生，M1 手动选）显示对应入口；选择存在本机设置里。
  useEffect(() => {
    if (!identity || !storeRef.current) return
    const store = storeRef.current
    let cancelled = false
    void store.get('settings', 'role').then(value => {
      if (cancelled) return
      const saved = value as { role?: unknown } | undefined
      if (saved?.role === 'student' || saved?.role === 'teacher') setRole(saved.role)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [identity, stackRevision])

  useEffect(()=>{
    if(!identity||!storeRef.current)return
    let cancelled=false;setBackupModel(false)
    void loadPersonalModel(storeRef.current).then(c=>{if(!cancelled)setModelConfig(c)}).catch(()=>{if(!cancelled)setModelConfig(null)})
    return()=>{cancelled=true}
  },[identity,stackRevision])

  // M1-15a：一个 transport + 收件分发 + 账本同步；有中继配置才启动。
  // M1-22：每位家人各起一个自己的中继连接（各自订阅、各自解密），账本仍只在本人这条连接上。
  useEffect(() => {
    if (!identity || !storeRef.current) return
    const store = storeRef.current
    let cancelled = false
    const opened: Wiring[] = []
    void (async () => {
      const config = (await store.list('backup-config'))[0]?.value as { relays?: unknown } | undefined
      const relays = Array.isArray(config?.relays) && config.relays.every(item => typeof item === 'string')
        ? config.relays as string[] : defaultRelays
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
        const who = memberIdentity(member, identity.language)
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
  }, [identity, stackRevision, family])

  useEffect(() => {
    const pause = (event: Event) => {
      const active = stackRef.current; stackRef.current = null
      if (active) (event as CustomEvent<{ pending: Promise<void>[] }>).detail.pending.push(active.close())
      setStackStatus('offline')
    }
    const restart = () => setStackRevision(value => value + 1)
    window.addEventListener('aster:store-restoring', pause)
    window.addEventListener('aster:store-restored', restart)
    window.addEventListener('aster:relays-changed', restart)
    return () => { window.removeEventListener('aster:store-restoring', pause); window.removeEventListener('aster:store-restored', restart); window.removeEventListener('aster:relays-changed', restart) }
  }, [])

  const replaceIdentity = async (result:Identity,after?:(fresh:LocalStore)=>Promise<void>) => {
    await stackRef.current?.close();stackRef.current=null
    storeRef.current?.close();storeRef.current=null
    identityRef.current?.privateKey.fill(0);identityRef.current=null
    setIdentity(null);setRole(null);setModelConfig(undefined);setRestoreNotice('')
    setFamily([]);setActive(0);setMemberStacks(new Map());setMemberStatus({})
    await clearStore()
    const fresh=await openStore(result);storeRef.current=fresh;identityRef.current=result;await after?.(fresh);const saved=await fresh.get('settings','role') as {role?:Role}|undefined;setRole(saved?.role??null);setIdentity(result);setLocked(false)
    setRecordsPage(false);setHomeworkPage(false);setError('')
  }
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
  const activeIdentity = useMemo(() => identity ? (activeMember ? memberIdentity(activeMember, identity.language) : identity) : null, [identity, activeMember])
  const activeStack = activeMember ? memberStacks.get(activeMember.account) ?? null : stack
  const activeStatus: LinkStatus = activeMember ? memberStatus[activeMember.account] ?? 'offline' : stackStatus
  const memberOptions = family.map(member => ({ account: member.account, alias: member.alias }))
  const refreshFamily = () => { if (storeRef.current) void loadFamilyMembers(storeRef.current).then(setFamily).catch(() => {}) }
  const modelGateway=useMemo(()=>identity&&env.VITE_MODEL_GATEWAY_URL?{baseUrl:env.VITE_MODEL_GATEWAY_URL,secretKey:identity.privateKey}:null,[identity])
  const llm=useMemo(()=>modelConfig?createPersonalClient(modelConfig,modelGateway,setBackupModel):null,[modelConfig,modelGateway])
  const modelNotice=<>{restoreNotice&&<p role="status">{restoreNotice}</p>}{backupModel&&<p role="status" style={{fontSize:12}}>今天用的是备用模型，请检查您的模型账户</p>}</>
  const modelSettings=store?<details><summary>我的大模型</summary><ModelSettings key={modelConfig?.testedAt??'new'} store={store} gateway={modelGateway} current={modelConfig??null} onSaved={config=>{setModelConfig(config);window.dispatchEvent(new Event('aster:model-changed'))}}/></details>:null
  if(identity&&role&&store&&!modelConfig)return <main style={{fontFamily:'system-ui',padding:16,maxWidth:480,margin:'0 auto'}}><h1>知衡</h1>{modelNotice}{modelConfig===undefined?<p>正在读取接入设置…</p>:<><ModelSettings initial store={store} gateway={modelGateway} current={null} onSaved={setModelConfig}/>{role==='teacher'&&<details><summary>社区首次登记</summary><InviteSettings identity={identity} gateway={gateway}/></details>}<details><summary>从备份恢复接入</summary><BackupSettings onRestored={setRestoreNotice} identity={identity} store={store}/><AdvancedRecovery store={store} onRestore={replaceIdentity}/></details></>}</main>
  // 学生端三个底部标签（镜子/问诊/其他）；老师端走 TeacherWorkspace 四页。模型由 M1-21 的 personal client 提供。
  // M1-22：学生壳用“当前家人”的分片存储与身份，设置区仍用根身份；家人切换在镜子页/问诊页顶部。
  if (store && identity && role === 'student') return <StudentShell store={store} identity={identity} llm={llm} stack={stack} stackStatus={activeStatus} persistence={persistence} defaultRelays={defaultRelays} onRestore={replaceIdentity} modelNotice={modelNotice} modelSettings={modelSettings} family={memberOptions} active={active} onSwitch={setActive} memberStore={activeStore ?? store} memberIdentity={activeIdentity ?? identity} sendConsult={activeStack?.sendConsult} sendEnvelope={activeStack?.send} onFamilyChanged={refreshFamily} />
  if (homeworkPage && store && identity) return <>{modelNotice}<div hidden><BackupSettings onRestored={setRestoreNotice} identity={identity} store={store} /><LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} /></div><Suspense fallback={<p>正在打开今日作业…</p>}><HomeworkPage store={store} onBack={() => setHomeworkPage(false)} /></Suspense></>
  if (recordsPage && store && identity) return <Suspense fallback={<p>正在打开病历…</p>}><StudentRecordsPage identity={identity} store={store} onBack={() => setRecordsPage(false)} /></Suspense>
  if (role==='teacher' && store && identity) return <Suspense fallback={<p>正在打开老师工作台…</p>}><TeacherWorkspace identity={identity} store={store} stack={stack} llm={llm} gateway={gateway} status={<>{modelNotice}<p role="status">中继：{stackStatus==='ready'?'已连接':stackStatus==='connecting'?'正在连接':'尚未连接'}</p></>} ledgerPanel={<LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus}/>} settings={<details><summary>设置</summary>
      <details><summary>调整使用角色</summary><button disabled={role==='teacher'} onClick={()=>void chooseRole('teacher')}>我是老师</button><button onClick={()=>void chooseRole('student')}>我是学生</button></details>
      {modelSettings}<TeacherListSettings store={store}/>{role==='teacher'&&<PilotSettings store={store}/>}
      <h3>存储状态</h3><p role="status">{persistenceLabels[persistence]}</p>
      <BackupSettings onRestored={setRestoreNotice} identity={identity} store={store}/>
      <PasskeySettings identity={identity} store={store} defaults={defaultRelays}/>
      <PushSettings identity={identity}/>
      <AdvancedRecovery store={store} onRestore={replaceIdentity}/>
    </details>} /></Suspense>
  return <main style={{fontFamily:'system-ui, sans-serif',padding:'24px 16px',maxWidth:480,margin:'0 auto'}}>
    <h1>知衡</h1>{modelNotice}
    {loading&&<p>正在准备…</p>}{error&&<p role="alert">{error}</p>}
    {!loading&&locked&&<button onClick={()=>void(async()=>{try{const {key}=await authenticatePasskey(),session=await resumeStore({unlockKey:key});if(!session)throw Error();storeRef.current=session.store;identityRef.current=session.identity;const saved=await session.store.get('settings','role') as {role?:Role}|undefined;setRole(saved?.role??null);setIdentity(session.identity);setLocked(false);setError('')}catch{setError('解锁未完成，请重试或使用恢复资料。')}})()}>刷脸解锁</button>}
    {!loading&&identity&&!role&&<section><h2>您是老师还是学生？</h2><button onClick={()=>void chooseRole('teacher')}>我是老师</button>{' '}<button onClick={()=>void chooseRole('student')}>我是学生</button></section>}
    {store&&identity&&<details><summary>设置</summary>
      <details><summary>调整使用角色</summary><button disabled={role==='teacher'} onClick={()=>void chooseRole('teacher')}>我是老师</button><button disabled={role==='student'} onClick={()=>void chooseRole('student')}>我是学生</button></details>
      {modelSettings}<TeacherListSettings store={store}/>{role==='teacher'&&<PilotSettings store={store}/>}
      <h3>存储状态</h3><p role="status">{persistenceLabels[persistence]}</p>
      <BackupSettings onRestored={setRestoreNotice} identity={identity} store={store}/><LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} members={memberOptions}/>
      <PasskeySettings identity={identity} store={store} defaults={defaultRelays}/>
      <PushSettings identity={identity}/>
      <AdvancedRecovery store={store} onRestore={replaceIdentity}/>
    </details>}
    {!identity&&!loading&&<AdvancedRecovery onRestore={replaceIdentity}/>}
    <details><summary>换手机后找回备份</summary><p>恢复会替换这台设备上的资料，请先保存需要保留的文件。照片不在中继备份中。</p><label><input type="checkbox" checked={allowReplace} onChange={e=>setAllowReplace(e.target.checked)}/>允许用备份替换本机资料</label><button disabled={!allowReplace||recovering||!globalThis.PublicKeyCredential} onClick={()=>{setRecovering(true);void(async()=>{try{const relays=store?await configuredRelays(store,defaultRelays):defaultRelays,{identity:found,key}=await recoverPasskey(relays);await replaceIdentity(found,async fresh=>{const relay=communityBackupRelay(found,relays),manager=createBackupManager({identity:found,store:fresh,relay});try{await manager.restoreLatest(true);await protectStore(found,key)}finally{manager.close();relay.close()}});setError('')}catch{setError('恢复未完成，请检查手机账户和社区备份后重试。')}finally{setRecovering(false)}})()}}>用刷脸找回备份</button></details>
    <p style={{fontSize:12}}>换手机前请到设置里备份</p>
  </main>
}
