import { PasskeySettings, configuredRelays } from './PasskeySettings'
import { authenticatePasskey } from './core/onboarding/passkey'
import { recoverPasskey } from './core/onboarding/identity-relay'
import { PasskeyUnlockRequired, resumeStore, protectStore } from './core/store'
import { createBackupManager } from './core/backup'
import { communityBackupRelay } from './core/backup/relay'
import { PilotSettings } from './PilotSettings'
import { createLlmClient } from './core/llm'
import { LedgerSettings } from './LedgerSettings'
import { BackupSettings } from './BackupSettings'
import './homework.css'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { PushSettings } from './PushSettings'

import type { Identity } from './core/identity'
import { AdvancedRecovery } from './AdvancedRecovery'
import { InviteSettings } from './InviteSettings'
import { bootstrapIdentity, readInviteLink, acceptInvite, gatewayBase, INVITE_ERROR } from './core/onboarding'
import { clearStore } from './core/store'
import { openStore, type LocalStore } from './core/store'
import { persistenceLabels, requestPersistence, type PersistenceStatus } from './core/store/persistence'
import { createWiring, type Wiring } from './core/wiring'
import { createPushClient } from './core/push'
import { TeacherListSettings } from './TeacherListSettings'

const HomeworkPage = lazy(() => import('./HomeworkPage').then(module => ({ default: module.HomeworkPage })))
const IntakePage = lazy(() => import('./IntakePage').then(module => ({ default: module.IntakePage })))
const StudentRecordsPage = lazy(() => import('./StudentRecordsPage').then(module => ({ default: module.StudentRecordsPage })))
const TeacherInboxPage = lazy(() => import('./TeacherInboxPage').then(module => ({ default: module.TeacherInboxPage })))

type Role = 'student' | 'teacher'
type LinkStatus = 'offline' | 'connecting' | 'ready' | 'rejected' | 'invalid-message'
const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
const defaultRelays = (env.VITE_COMMUNITY_RELAYS ?? '').split(',').map(value => value.trim()).filter(Boolean)
// 部署时配置这两个变量，发送成功后才会调用 M1-08 的 notifyRecipient；没配置就不提醒，不影响发送。
const pushGatewayUrl = env.VITE_PUSH_GATEWAY_URL ?? ''
const pushVapidPublicKey = env.VITE_PUSH_VAPID_PUBLIC_KEY ?? ''

const gateway = gatewayBase(env.VITE_MODEL_GATEWAY_URL ?? pushGatewayUrl)

export function App() {
  const [locked,setLocked]=useState(false),[recovering,setRecovering]=useState(false),[allowReplace,setAllowReplace]=useState(false)
  const [homeworkPage, setHomeworkPage] = useState(false)
  const [intakePage, setIntakePage] = useState(false)
  const [recordsPage, setRecordsPage] = useState(false)
  const [inboxPage, setInboxPage] = useState(false)
  const [stackRevision, setStackRevision] = useState(0)
  const [role, setRole] = useState<Role | null>(null)
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

  // M1-15a：一个 transport + 收件分发 + 账本同步；有中继配置才启动。
  useEffect(() => {
    if (!identity || !storeRef.current) return
    const store = storeRef.current
    let cancelled = false
    void (async () => {
      const config = (await store.list('backup-config'))[0]?.value as { relays?: unknown } | undefined
      const relays = Array.isArray(config?.relays) && config.relays.every(item => typeof item === 'string')
        ? config.relays as string[] : defaultRelays
      if (cancelled || relays.length === 0) return
      const stack = createWiring({
        identity, store, relays,
        onChange: () => window.dispatchEvent(new Event('aster:data-changed')),
        onStatus: status => { if (!cancelled) setStackStatus(status as LinkStatus) },
        onError: () => { if (!cancelled) setStackStatus('offline') },
        notifier: async pubkey => {
          if (!pushGatewayUrl || !pushVapidPublicKey) return
          const client = createPushClient({ gatewayUrl: pushGatewayUrl, vapidPublicKey: pushVapidPublicKey, secretKey: identity.privateKey })
          await client.notifyRecipient(pubkey)
        },
      })
      stackRef.current = stack
      stack.start()
      // M1-05 接通后，把本机待发的替身问诊包真实发出，成功后删除。
      void stack.flushIntakeOutbox().catch(() => {})
    })().catch(() => {})
    return () => {
      cancelled = true
      const stack = stackRef.current
      stackRef.current = null
      if (stack) void stack.close()
    }
  }, [identity, stackRevision])

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
    setIdentity(null);setRole(null)
    await clearStore()
    const fresh=await openStore(result);storeRef.current=fresh;identityRef.current=result;await after?.(fresh);const saved=await fresh.get('settings','role') as {role?:Role}|undefined;setRole(saved?.role??null);setIdentity(result);setLocked(false)
    setIntakePage(false);setRecordsPage(false);setHomeworkPage(false);setInboxPage(false);setError('')
  }
  const chooseRole = async (next: Role) => {
    setError('')
    setRole(next)
    try { if (storeRef.current) await storeRef.current.put('settings', 'role', { role: next }) }
    catch { setError('角色没有保存成功，请重试。') }
  }

  const store = storeRef.current
  const stack = stackRef.current
  const llm = identity && env.VITE_MODEL_GATEWAY_URL ? createLlmClient({ kind: 'gateway', baseUrl: env.VITE_MODEL_GATEWAY_URL, secretKey: identity.privateKey }) : null
  if (homeworkPage && store && identity) return <><div hidden><BackupSettings identity={identity} store={store} /><LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} /></div><Suspense fallback={<p>正在打开今日作业…</p>}><HomeworkPage store={store} onBack={() => setHomeworkPage(false)} /></Suspense></>
  if (intakePage && store && identity) return <><div hidden><BackupSettings identity={identity} store={store} /><LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} /></div><Suspense fallback={<p>正在打开采集页…</p>}><IntakePage store={store} identity={identity} sendConsult={stack?.sendConsult} onBack={() => setIntakePage(false)} /></Suspense></>
  if (recordsPage && store && identity) return <Suspense fallback={<p>正在打开病历…</p>}><StudentRecordsPage identity={identity} store={store} onBack={() => setRecordsPage(false)} /></Suspense>
  if (inboxPage && store && identity) {
    return <Suspense fallback={<p>正在打开问诊箱…</p>}>
      {stack
        ? <TeacherInboxPage llm={llm} identity={identity} store={store} send={stack.send} ledger={stack.ledger} onBack={() => setInboxPage(false)} />
        : <main style={{ padding: 24 }}>
          <h1>问诊箱</h1>
          <p role="alert">还没有配置社区中继，暂时收不到问诊。请先在“设置 → 社区备份中继”里填写中继地址。</p>
          <button onClick={() => setInboxPage(false)}>返回</button>
        </main>}
    </Suspense>
  }
  return <main style={{fontFamily:'system-ui, sans-serif',padding:'24px 16px',maxWidth:480,margin:'0 auto'}}>
    <h1>知衡</h1>
    {loading&&<p>正在准备…</p>}{error&&<p role="alert">{error}</p>}
    {!loading&&locked&&<button onClick={()=>void(async()=>{try{const {key}=await authenticatePasskey(),session=await resumeStore({unlockKey:key});if(!session)throw Error();storeRef.current=session.store;identityRef.current=session.identity;const saved=await session.store.get('settings','role') as {role?:Role}|undefined;setRole(saved?.role??null);setIdentity(session.identity);setLocked(false);setError('')}catch{setError('解锁未完成，请重试或使用恢复资料。')}})()}>刷脸解锁</button>}
    {!loading&&identity&&!role&&<section><h2>您是老师还是学生？</h2><button onClick={()=>void chooseRole('teacher')}>我是老师</button>{' '}<button onClick={()=>void chooseRole('student')}>我是学生</button></section>}
    {identity&&role&&<>
      <h2>{role==='teacher'?'老师首页':'问诊首页'}</h2>
      <p role="status">中继：{stackStatus==='ready'?'已连接':stackStatus==='connecting'?'正在连接':stackStatus==='rejected'?'连接未成功，请联系老师':'尚未连接'}</p>
      {role==='teacher'?<><InviteSettings identity={identity} gateway={gateway}/><p><button onClick={()=>setInboxPage(true)}>问诊箱</button></p></>:<><p><button onClick={()=>setIntakePage(true)}>开始采集</button></p><p><button onClick={()=>setRecordsPage(true)}>我的病历</button></p><p><button onClick={()=>setHomeworkPage(true)}>今日作业</button></p></>}
    </>}
    {store&&identity&&<details><summary>设置</summary>
      <details><summary>调整使用角色</summary><button disabled={role==='teacher'} onClick={()=>void chooseRole('teacher')}>我是老师</button><button disabled={role==='student'} onClick={()=>void chooseRole('student')}>我是学生</button></details>
      <TeacherListSettings store={store}/>{role==='teacher'&&<PilotSettings store={store}/>}
      <h3>存储状态</h3><p role="status">{persistenceLabels[persistence]}</p>
      <BackupSettings identity={identity} store={store}/><LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus}/>
      <PasskeySettings identity={identity} store={store} defaults={defaultRelays}/>
      <PushSettings identity={identity}/>
      <AdvancedRecovery store={store} onRestore={replaceIdentity}/>
    </details>}
    {!identity&&!loading&&<AdvancedRecovery onRestore={replaceIdentity}/>}
    <details><summary>换手机后找回备份</summary><p>恢复会替换这台设备上的资料，请先保存需要保留的文件。照片不在中继备份中。</p><label><input type="checkbox" checked={allowReplace} onChange={e=>setAllowReplace(e.target.checked)}/>允许用备份替换本机资料</label><button disabled={!allowReplace||recovering||!globalThis.PublicKeyCredential} onClick={()=>{setRecovering(true);void(async()=>{try{const relays=store?await configuredRelays(store,defaultRelays):defaultRelays,{identity:found,key}=await recoverPasskey(relays);await replaceIdentity(found,async fresh=>{const relay=communityBackupRelay(found,relays),manager=createBackupManager({identity:found,store:fresh,relay});try{await manager.restoreLatest(true);await protectStore(found,key)}finally{manager.close();relay.close()}});setError('')}catch{setError('恢复未完成，请检查手机账户和社区备份后重试。')}finally{setRecovering(false)}})()}}>用刷脸找回备份</button></details>
    <p style={{fontSize:12}}>换手机前请到设置里备份</p>
  </main>
}
