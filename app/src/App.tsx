import { PilotSettings } from './PilotSettings'
import { createLlmClient } from './core/llm'
import { LedgerSettings } from './LedgerSettings'
import { BackupSettings } from './BackupSettings'
import './homework.css'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { PushSettings } from './PushSettings'
import { createIdentity, generatePhrase, languages, languageLabels, restoreIdentity } from './core/identity'
import type { Identity, Language } from './core/identity'
import { beginBackup, checkBackup } from './core/identity/backup'
import type { BackupChallenge } from './core/identity/backup'
import { openStore, resumeStore, type LocalStore } from './core/store'
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

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export function App() {
  const [homeworkPage, setHomeworkPage] = useState(false)
  const [intakePage, setIntakePage] = useState(false)
  const [recordsPage, setRecordsPage] = useState(false)
  const [inboxPage, setInboxPage] = useState(false)
  const [stackRevision, setStackRevision] = useState(0)
  const [role, setRole] = useState<Role | null>(null)
  const [stackStatus, setStackStatus] = useState<LinkStatus>('offline')
  const [language, setLanguage] = useState<Language>('simplified')
  const [step, setStep] = useState<'start' | 'write' | 'check' | 'restore' | 'done'>('start')
  const [phrase, setPhrase] = useState('')
  const [challenge, setChallenge] = useState<BackupChallenge | null>(null)
  const [answers, setAnswers] = useState(['', '', ''])
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [persistence, setPersistence] = useState<PersistenceStatus>('requesting')
  const storeRef = useRef<LocalStore | null>(null)
  const identityRef = useRef<Identity | null>(null)
  const stackRef = useRef<Wiring | null>(null)

  useEffect(() => {
    let cancelled = false
    void requestPersistence(navigator.storage).then(status => { if (!cancelled) setPersistence(status) })
    void resumeStore().then(session => {
      if (cancelled) { session?.store.close(); session?.identity.privateKey.fill(0); return }
      if (session) {
        storeRef.current = session.store; identityRef.current = session.identity
        setIdentity(session.identity); setStep('done')
      }
    }).catch(cause => { if (!cancelled) setError(errorMessage(cause, '本地存储不可用，请用助记词恢复')) })
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

  const reset = () => {
    stackRef.current?.close(); stackRef.current = null
    storeRef.current?.close(); storeRef.current = null; identityRef.current = null
    identity?.privateKey.fill(0)
    setIdentity(null); setPhrase(''); setChallenge(null); setAnswers(['', '', ''])
    setError(''); setStep('start'); setRole(null); setHomeworkPage(false); setIntakePage(false); setRecordsPage(false); setInboxPage(false)
    setStackStatus('offline')
  }
  const complete = async (result: Identity) => {
    setBusy(true)
    try {
      const store = await openStore(result)
      storeRef.current?.close(); storeRef.current = store; identityRef.current = result
      setIdentity(result); setPhrase(''); setChallenge(null); setAnswers(['', '', '']); setError(''); setStep('done')
    } catch (cause) { result.privateKey.fill(0); setError(errorMessage(cause, '无法保存身份，请重试')) }
    finally { setBusy(false) }
  }
  const chooseRole = async (next: Role) => {
    setError('')
    setRole(next)
    try { if (storeRef.current) await storeRef.current.put('settings', 'role', { role: next }) }
    catch (cause) { setError(errorMessage(cause, '角色没有保存成功')) }
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
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '24px 16px', maxWidth: 480, margin: '0 auto' }}>
      <h1>知衡 · 身份</h1>
      <p>请用生成时的同一种文字恢复</p>
      <p>身份由设备密钥加密保存在本机，重新打开可自动解锁。浏览器数据被清空后，请用助记词恢复；业务数据还需从备份恢复。请妥善抄写，不要交给他人。</p>
      {loading && <p>正在解锁本地身份…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && step === 'start' && <>
        <label>助记词文字 <select value={language} onChange={event => setLanguage(event.target.value as Language)}>{languages.map(item => <option key={item} value={item}>{languageLabels[item]}</option>)}</select></label>
        <p><button onClick={() => { try { setPhrase(generatePhrase(language)); setStep('write') } catch { setError('无法生成身份，请使用支持安全随机数的浏览器') } }}>生成新身份</button></p>
        <button onClick={() => setStep('restore')}>使用助记词恢复</button>
      </>}
      {step === 'write' && <>
        <h2>按顺序抄写 12 个词</h2>
        <ol>{phrase.split(' ').map((word, index) => <li key={index}>{word}</li>)}</ol>
        <button onClick={() => { setChallenge(beginBackup(phrase)); setStep('check') }}>我已抄写，开始核对</button>
      </>}
      {step === 'check' && challenge && <form onSubmit={async event => {
        event.preventDefault()
        if (!checkBackup(challenge, answers)) { setError('核对不通过，请检查抄写的词及顺序'); return }
        if (busy) return
        try { await complete(createIdentity(phrase, language)) } catch { setError('身份生成失败，请重新开始') }
      }}>
        <h2>核对抄写</h2>
        {challenge.positions.map((position, index) => <p key={position}><label>第 {position + 1} 个词 <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={answers[index]} onChange={event => setAnswers(previous => previous.map((answer, i) => i === index ? event.target.value : answer))} /></label></p>)}
        <button type="submit" disabled={busy}>核对并完成</button>
      </form>}
      {step === 'restore' && <form onSubmit={async event => {
        event.preventDefault()
        if (busy) return
        try { await complete(restoreIdentity(phrase)) } catch (cause) { setError(errorMessage(cause, '恢复失败')) }
      }}>
        <label>输入 12 个词（中文可连写，英文用空格或标点分隔，自动识别文字）<textarea rows={5} style={{ width: '100%', boxSizing: 'border-box' }} autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={event => setPhrase(event.target.value)} /></label>
        <button type="submit" disabled={busy}>校验并恢复</button>
      </form>}
      {step === 'done' && identity && <>
        <h2>身份已就绪</h2>
        <p>当前角色：{role === 'teacher' ? '老师' : role === 'student' ? '学生' : '未选择'}（M1 手动选择，可在设置里切换）</p>
        <p role="status">中继：{stackStatus === 'ready' ? '已连接' : stackStatus === 'connecting' ? '正在连接' : stackStatus === 'rejected' ? '中继拒绝连接，请核对成员资格' : '尚未连接（可在设置里配置社区中继）'}</p>
        {role === 'student' && <section>
          <h3>学生入口</h3>
          <p><button type="button" onClick={() => setIntakePage(true)}>开始采集</button></p>
          <p><button type="button" onClick={() => setRecordsPage(true)}>我的病历</button></p>
          <p><button type="button" onClick={() => setHomeworkPage(true)}>今日作业</button></p>
        </section>}
        {role === 'teacher' && <section>
          <h3>老师入口</h3>
          <p><button type="button" onClick={() => setInboxPage(true)}>问诊箱</button></p>
        </section>}
        <details><summary>设置</summary>
          <h3>身份角色</h3>
          <p><button type="button" disabled={role === 'student'} onClick={() => void chooseRole('student')}>我是学生</button>{' '}<button type="button" disabled={role === 'teacher'} onClick={() => void chooseRole('teacher')}>我是老师</button></p>
          {store && <TeacherListSettings store={store} />}
          {role === 'teacher' && store && <PilotSettings store={store} />}
          <h3>存储状态</h3><p role="status">{persistenceLabels[persistence]}</p><p>持久化存储不能替代备份。</p>
          {store && <><BackupSettings identity={identity} store={store} /><LedgerSettings managed identity={identity} store={store} ledger={stack?.ledger} status={stackStatus} /></>}
        </details>
        <PushSettings identity={identity} />
        <p>词表：{languageLabels[identity.language]} · 账户：{identity.account}（本人）</p>
        <p style={{ overflowWrap: 'anywhere' }}>公钥 npub：{identity.npub}</p>
        <p style={{ overflowWrap: 'anywhere' }}>公钥十六进制：{identity.publicKey}</p>
      </>}
      {step !== 'start' && <p><button disabled={busy} onClick={reset}>{step === 'done' ? '返回首页' : '取消并返回'}</button></p>}
    </main>
  )
}
