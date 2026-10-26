import { PilotSettings } from './PilotSettings'
import {createPersonalClient, loadPersonalModel, type PersonalModel} from './core/llm/personal'
import {clearCommunityModel, communityError, createCommunityClient, loadCommunityModel, saveCommunityModel, testCommunityModel, type CommunityModel} from './core/llm/community'
import {ModelSettings} from './ModelSettings'
import { LedgerSettings } from './LedgerSettings'
import './homework.css'
import { lazy, Suspense, useEffect, useRef, useState, useMemo } from 'react'
import { PushSettings } from './PushSettings'
import { OpeningGuide } from './OpeningGuide'
import { hasOpenedHall, loadHall } from './core/hall'
import { TongueLevelSettings } from './TongueLevelSettings'
import { TemplateSettings } from './TemplateSettings'
import { CommunityDashboard } from './CommunityDashboard'
import { dashboardConfig } from './core/dashboard/config'
import { recordError } from './core/dashboard/errors'
import { startStatsSession } from './core/dashboard/session'
import { sendDailyStats } from './core/dashboard/stats'

import type { Identity } from './core/identity'
import { bootstrapIdentity, readInviteLink, acceptInvite, gatewayBase, INVITE_ERROR, validateInvite } from './core/onboarding'
import { loadTeachers, type SendEnvelope } from './core/inbox'
import { readReidentifyLink } from './core/reidentify'
import { StudentReidentifyRequestPage, TeacherReidentifyPrompt } from './ReidentifyPages'
import { inviteWelcome, loadCachedStorefront, saveReceivedStorefront, type Storefront } from './core/storefront'
import { readStorefrontLink } from './core/storefront/invite'
import { StorefrontWelcome } from './StorefrontWelcome'
import type { Event } from 'nostr-tools/pure'
import type { LocalStore } from './core/store'
import { createWiring, type Wiring } from './core/wiring'
import { createPushClient } from './core/push'
import { TeacherListSettings } from './TeacherListSettings'
import { StudentShell } from './StudentShell'
import { loadFamilyMembers, memberIdentity, memberStore, type FamilyMember } from './core/family'
import { markRestoreNeeded } from './core/records/backup'
import { runRetentionOnce } from './core/records/retention'
import { takeSetupToken } from './core/setup-link'

const TeacherShell = lazy(() => import('./TeacherShell').then(module => ({default:module.TeacherShell})))

type Role = 'student' | 'teacher'
type LinkStatus = 'offline' | 'connecting' | 'ready' | 'rejected' | 'invalid-message'
type RecoveryFlow =
  | { kind: 'student'; teacher: string; name: string }
  | { kind: 'teacher'; newTeacher: string; name: string; oldTeachers: string[] }
const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
const defaultRelays = (env.VITE_COMMUNITY_RELAYS ?? '').split(',').map(value => value.trim()).filter(Boolean)
// V2-14：仪表盘公钥/地址由部署 .env 注入；留空就完全不发。
const dashboard = dashboardConfig(env)
// 部署时配置这两个变量，发送成功后才会调用 M1-08 的 notifyRecipient；没配置就不提醒，不影响发送。
const pushGatewayUrl = env.VITE_PUSH_GATEWAY_URL ?? ''
const pushVapidPublicKey = env.VITE_PUSH_VAPID_PUBLIC_KEY ?? ''

const gateway = gatewayBase(env.VITE_MODEL_GATEWAY_URL ?? pushGatewayUrl)

export function App() {
  const [modelConfig,setModelConfig]=useState<PersonalModel|null|undefined>(undefined)
  // V2-28：部署开了社区网关模型时，学生可以先不填自己的 Key；只用本机标记，不存密钥。
  const [communityConfig,setCommunityConfig]=useState<CommunityModel|null|undefined>(undefined)
  const [communityBusy,setCommunityBusy]=useState(false)
  const [communityNotice,setCommunityNotice]=useState('')
  const [backupModel,setBackupModel]=useState(false)
  const [role, setRole] = useState<Role | null>(null)
  // V2-15：老师第一次进来先走建馆引导；老部署已有门面/学生/问诊的直接视为已开馆。
  // V2-14：只读仪表盘走同一个单页的 hash，不新增服务器接口；hash 里的钥匙读一次就收起来。
  const [dashboardRoute] = useState(() => location.hash.startsWith('#dashboard'))
  const [hallOpened, setHallOpened] = useState<boolean | null>(null)
  // M1-22 家人子账户：家人清单、当前在看谁（0 = 本人），以及每位家人的中继连接。
  const [family, setFamily] = useState<FamilyMember[]>([])
  const [active, setActive] = useState(0)
  const [memberStacks, setMemberStacks] = useState<ReadonlyMap<number, Wiring>>(new Map())
  const [memberStatus, setMemberStatus] = useState<Record<number, LinkStatus>>({})
  const [stackStatus, setStackStatus] = useState<LinkStatus>('offline')
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [recovery, setRecovery] = useState<RecoveryFlow | null>(null)
  // V2-09：新学生打开有效邀请、本机还没有这位老师时，先看老师的邀请首屏。
  const [welcome, setWelcome] = useState<{ invitation: Event; storefront: Storefront | null } | null>(null)
  const [welcomeBusy, setWelcomeBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const storeRef = useRef<LocalStore | null>(null)
  const identityRef = useRef<Identity | null>(null)
  const stackRef = useRef<Wiring | null>(null)
  const statsSending = useRef(false)

  // V2-13：启动即注册现有 sw.js（只管推送通知），“添加到主屏幕”不再依赖先开提醒。
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    void navigator.serviceWorker.register('/sw.js').catch(() => {})
  }, [])

  // V2-31：扫码登记链接的 #setup=<口令> 由建馆引导读取；这里兜底清掉，
  // 避免在其它入口打开时把口令留在地址栏（口令一次性、用完作废）。
  useEffect(() => { if (location.hash.startsWith('#setup=')) takeSetupToken() }, [])

  // V2-14：只记录错误类型，不记内容；统计只读这些次数。
  useEffect(() => {
    if (!identity || !storeRef.current) return
    const store = storeRef.current
    const uncaught = () => { void recordError(store, 'uncaughtError') }
    const rejection = () => { void recordError(store, 'unhandledRejection') }
    window.addEventListener('error', uncaught)
    window.addEventListener('unhandledrejection', rejection)
    return () => { window.removeEventListener('error', uncaught); window.removeEventListener('unhandledrejection', rejection) }
  }, [identity])

  // V2-14：老师端累计当天应用在线秒数（统计里的“服务在线时长”）。
  useEffect(() => {
    if (role !== 'teacher' || !identity || !storeRef.current) return
    const store = storeRef.current
    let live = true
    let timer: ReturnType<typeof setInterval> | null = null
    let statsSession: Awaited<ReturnType<typeof startStatsSession>> | null = null
    void startStatsSession(store).then(next => {
      if (!live) return
      statsSession = next
      timer = setInterval(() => { void next.tick().catch(() => {}) }, 60_000)
    }).catch(() => {})
    const flush = () => { void statsSession?.tick().catch(() => {}) }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      live = false
      if (timer) clearInterval(timer)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
      void statsSession?.stop().catch(() => {})
    }
  }, [role, identity])

  // V2-14：打开应用且中继就绪时，若开关开、配置了仪表盘、今天还没发，就发一条统计。
  useEffect(() => {
    if (role !== 'teacher' || !identity || stackStatus !== 'ready' || !dashboard.configured || statsSending.current) return
    const store = storeRef.current, stack = stackRef.current
    if (!store || !stack) return
    statsSending.current = true
    void sendDailyStats({ store, send: stack.send, dashboardPubkey: dashboard.pubkey, dashboardUrl: dashboard.url })
      .catch(() => {})
      .finally(() => { statsSending.current = false })
  }, [role, identity, stackStatus])

  useEffect(() => {
    let cancelled = false
    void bootstrapIdentity().then(async session => {
      if (cancelled) { session.store.close(); session.identity.privateKey.fill(0); return }
      const {store,identity: person}=session
      storeRef.current=store;identityRef.current=person
      try {
        // V2-07：带 reidentify 标记的是换机找回链接（学生换手机 / 老师换手机），与普通邀请分开处理。
        const recoveryLink=readReidentifyLink(location.href)
        if(recoveryLink){
          history.replaceState(null,'',location.pathname+location.search)
          if(recoveryLink.kind==='student'){
            // 学生换手机：老师身份没变。先照常加入社区，再填称呼发认回请求。
            await acceptInvite(person,store,recoveryLink.event,gateway+'/invite/redeem')
            await markRestoreNeeded(store)
            if(!cancelled)setRecovery({kind:'student',teacher:recoveryLink.event.pubkey,name:recoveryLink.name})
          }else if(validateInvite(recoveryLink.event,gateway+'/invite/redeem')){
            // 老师换手机：学生点“是”之前不改名单、不接受新公钥，所以这里只先亮出提示。
            const oldTeachers=await loadTeachers(store)
            if(!cancelled)setRecovery({kind:'teacher',newTeacher:recoveryLink.event.pubkey,name:recoveryLink.name,oldTeachers})
          }else{
            setError(INVITE_ERROR)
          }
        }else{
          const invitation=readInviteLink(location.href)
          if(invitation){
            // V2-09：邀请核验失败或过期只提示，不显示门面；门面必须由邀请里的老师本人签名。
            if(!validateInvite(invitation,gateway+'/invite/redeem'))throw Error(INVITE_ERROR)
            const teachers=await loadTeachers(store)
            const linked=readStorefrontLink(location.href,invitation.pubkey)
            if(linked)await saveReceivedStorefront(store,linked.event,invitation.pubkey).catch(()=>{})
            const cached=await loadCachedStorefront(store,invitation.pubkey)
            const decision=inviteWelcome(teachers,invitation.pubkey,linked?.storefront??cached)
            if(decision.kind==='welcome'){
              // 首屏先认门；点“开始使用”才走原来的加入流程。
              if(!cancelled)setWelcome({invitation,storefront:decision.storefront})
            }else{
              await acceptInvite(person,store,invitation,gateway+'/invite/redeem');history.replaceState(null,'',location.pathname+location.search)
              // V2-05：重新进入社区后，连上中继时自动向老师要回保留期内的记录。
              await markRestoreNeeded(store)
            }
          }
        }
      } catch (cause) {setError(cause instanceof Error&&cause.message===INVITE_ERROR?INVITE_ERROR:'暂时未能加入社区，请稍后重新打开邀请。')}
      if(cancelled){store.close();person.privateKey.fill(0);return}
      const saved=await store.get('settings','role') as {role?:Role}|undefined
      const nextRole=saved?.role??null
      // V2-15：老师端先判定这座馆开没开；老部署有门面/学生/问诊就跳过引导。
      // 新馆开馆后还要等第一位学生加入（completedAt）才算走完引导。
      let opened: boolean | null = null
      if (nextRole === 'teacher') {
        try {
          const hall = await loadHall(store)
          opened = hall ? Boolean(hall.completedAt) : await hasOpenedHall(store, person)
        } catch { opened = false }
      }
      setHallOpened(opened)
      setRole(nextRole);setIdentity(person)
      // V2-05 第 4 步：打开应用时每天跑一次保留期清理（不做后台任务）。
      if(nextRole) void runRetentionOnce(store,nextRole).catch(()=>{})
      void loadFamilyMembers(store).then(rows => {
        if (cancelled) return
        setFamily(rows)
        for (const member of rows) void runRetentionOnce(memberStore(store,member.account),'student').catch(()=>{})
      }).catch(() => {})
    }).catch(() => { if(!cancelled) setError('本机资料暂时无法打开，请稍后重试。') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; stackRef.current?.close(); stackRef.current = null; storeRef.current?.close(); storeRef.current = null; identityRef.current?.privateKey.fill(0); identityRef.current = null }
  }, [])

  useEffect(()=>{
    if(!identity||!storeRef.current)return
    let cancelled=false;setBackupModel(false)
    void loadPersonalModel(storeRef.current).then(c=>{if(!cancelled)setModelConfig(c)}).catch(()=>{if(!cancelled)setModelConfig(null)})
    void loadCommunityModel(storeRef.current).then(c=>{if(!cancelled)setCommunityConfig(c)}).catch(()=>{if(!cancelled)setCommunityConfig(null)})
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
    if (next === 'teacher' && storeRef.current && identityRef.current) {
      try {
        const hall = await loadHall(storeRef.current)
        setHallOpened(hall ? Boolean(hall.completedAt) : await hasOpenedHall(storeRef.current, identityRef.current))
      } catch { setHallOpened(false) }
    } else setHallOpened(null)
    setRole(next)
    try { if (storeRef.current) await storeRef.current.put('settings', 'role', { role: next }) }
    catch { setError('角色没有保存成功，请重试。') }
  }

  // V2-09：邀请首屏点“开始使用”才加入社区；失败停在首屏提示，不显示门面以外的东西。
  const startWelcome = async () => {
    if (!welcome) return
    const savedStore = storeRef.current, person = identityRef.current
    if (!savedStore || !person) return
    setWelcomeBusy(true); setError('')
    try {
      await acceptInvite(person, savedStore, welcome.invitation, gateway + '/invite/redeem')
      await markRestoreNeeded(savedStore)
      history.replaceState(null, '', location.pathname + location.search)
      setWelcome(null)
      setRole('student')
    } catch (cause) {
      setError(cause instanceof Error && cause.message === INVITE_ERROR ? INVITE_ERROR : '暂时未能加入社区，请稍后重新打开邀请。')
    } finally { setWelcomeBusy(false) }
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
  // 部署用 COMMUNITY_MODEL=1 告诉网页“社区网关模型已接好”；学生据此可以不填自己的 Key。
  const communityOffered=Boolean(modelGateway&&env.VITE_COMMUNITY_MODEL==='1')
  const saveOwnModel=(config:PersonalModel)=>{
    const local=storeRef.current
    if(local)void clearCommunityModel(local).catch(()=>{})
    setCommunityConfig(null);setCommunityNotice('');setModelConfig(config)
  }
  // 先用社区模型：先试一句，能用才记标记并进入首页；不能用就说清是哪种情况。
  const startWithCommunity=async()=>{
    const local=storeRef.current
    if(!local||!modelGateway||communityBusy)return
    setCommunityBusy(true);setCommunityNotice('')
    try{await testCommunityModel(modelGateway);setCommunityConfig(await saveCommunityModel(local))}
    catch(cause){setCommunityNotice(communityError(cause))}
    finally{setCommunityBusy(false)}
  }
  const llm=useMemo(()=>modelConfig?createPersonalClient(modelConfig,modelGateway,setBackupModel):communityConfig&&modelGateway?createCommunityClient(modelGateway):null,[modelConfig,communityConfig,modelGateway])
  const modelNotice=<>{backupModel&&<p role="status" style={{fontSize:12}}>今天用的是备用模型，请检查您的模型账户</p>}</>
  const modelSettings=store?<details><summary>我的大模型</summary><ModelSettings key={modelConfig?.testedAt??'community-'+(communityConfig?.testedAt??'new')} store={store} gateway={modelGateway} current={modelConfig??null} onSaved={saveOwnModel}/></details>:null
  // V2-14：只读社区仪表盘。没有解密钥匙时不显示任何数据，也不渲染任何操作控件。
  if (dashboardRoute) return <CommunityDashboard relays={defaultRelays} />
  // V2-07：换机找回链接先走认回页；学生没点“是”之前不改名单、不接受新老师公钥。
  if (store && identity && recovery) {
    return recovery.kind === 'student'
      ? <StudentReidentifyRequestPage store={store} teacher={recovery.teacher} name={recovery.name} send={stack?.send} connected={stackStatus === 'ready'} onDone={() => setRecovery(null)} />
      : <TeacherReidentifyPrompt store={store} newTeacher={recovery.newTeacher} name={recovery.name} oldTeachers={recovery.oldTeachers} send={stack?.send} connected={stackStatus === 'ready'} onDone={() => setRecovery(null)} />
  }
  // V2-09：新学生的邀请首屏（标志、馆名、老师邀请你、短介绍、一个“开始使用”）。
  if (store && identity && welcome) {
    return <StorefrontWelcome storefront={welcome.storefront} teacher={welcome.invitation.pubkey} busy={welcomeBusy} error={error} onStart={() => void startWelcome()} />
  }
  // V2-15：没走完建馆引导前，老师端只有引导，别的功能一律不显示。
  if (role === 'teacher' && store && identity && hallOpened === null) {
    return <main style={{ fontFamily: 'system-ui', padding: 16, maxWidth: 480, margin: '0 auto' }}><h1>知衡</h1><p>正在准备…</p></main>
  }
  if (role === 'teacher' && store && identity && hallOpened === false) {
    return <OpeningGuide identity={identity} store={store} gateway={gateway} send={stack?.send as SendEnvelope | undefined} modelGateway={modelGateway} modelConfig={modelConfig} onModelSaved={saveOwnModel} onDone={() => setHallOpened(true)} />
  }
  if(identity&&role==='student'&&store&&!modelConfig&&!communityConfig){
    if(modelConfig===undefined||communityConfig===undefined)return <main style={{fontFamily:'system-ui',padding:16,maxWidth:480,margin:'0 auto'}}><h1>知衡</h1><p>正在读取接入设置…</p></main>
    return <ModelSettings initial store={store} gateway={modelGateway} current={null} onSaved={saveOwnModel}
      community={communityOffered?{available:true,busy:communityBusy,error:communityNotice,onStart:()=>void startWithCommunity()}:undefined} />
  }
  // V2-16：学生端三个底部标签（今天/记录/我），老师端三个标签（今天/学生/我的馆）。模型由 M1-21 的 personal client 提供。
  // M1-22：学生壳用“当前家人”的分片存储与身份，设置区仍用根身份；家人切换在今天页顶部。
  if (store && identity && role === 'student') return <StudentShell store={store} identity={identity} llm={llm} stack={stack} stackStatus={activeStatus} modelNotice={modelNotice} modelSettings={modelSettings} family={memberOptions} active={active} onSwitch={setActive} memberStore={activeStore ?? store} memberIdentity={activeIdentity ?? identity} sendConsult={activeStack?.sendConsult} sendEnvelope={activeStack?.send} onFamilyChanged={refreshFamily}
    notifySelf={async () => { if (pushGatewayUrl && pushVapidPublicKey) await createPushClient({ gatewayUrl: pushGatewayUrl, vapidPublicKey: pushVapidPublicKey, secretKey: identity.privateKey }).notifySubscribedSelf(identity.publicKey) }} />
  if (role==='teacher' && store && identity) return <Suspense fallback={<p>正在打开老师工作台…</p>}><TeacherShell identity={identity} store={store} stack={stack} llm={llm} gateway={gateway} status={<>{modelNotice}<p role="status">中继：{stackStatus==='ready'?'已连接':stackStatus==='connecting'?'正在连接':'尚未连接'}</p></>} ledgerPanel={<LedgerSettings managed flat identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} llm={llm}/>} settings={<details><summary>设置</summary>
      <details><summary>调整使用角色</summary><button disabled={role==='teacher'} onClick={()=>void chooseRole('teacher')}>我是老师</button><button onClick={()=>void chooseRole('student')}>我是学生</button></details>
      {modelSettings}<TongueLevelSettings store={store}/><TemplateSettings store={store}/><TeacherListSettings store={store}/><PilotSettings store={store}/>
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
