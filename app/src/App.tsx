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

const HomeworkPage = lazy(() => import('./HomeworkPage').then(module => ({ default: module.HomeworkPage })))
const IntakePage = lazy(() => import('./IntakePage').then(module => ({ default: module.IntakePage })))

export function App() {
  const [homeworkPage, setHomeworkPage] = useState(false)
  const [intakePage, setIntakePage] = useState(false)
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
  useEffect(() => {
    let cancelled = false
    void requestPersistence(navigator.storage).then(status => { if (!cancelled) setPersistence(status) })
    void resumeStore().then(session => {
      if (cancelled) { session?.store.close(); session?.identity.privateKey.fill(0); return }
      if (session) {
        storeRef.current = session.store; identityRef.current = session.identity
        setIdentity(session.identity); setStep('done')
      }
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : '本地存储不可用，请用助记词恢复') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; storeRef.current?.close(); storeRef.current = null; identityRef.current?.privateKey.fill(0); identityRef.current = null }
  }, [])
  const reset = () => {
    storeRef.current?.close(); storeRef.current = null; identityRef.current = null
    identity?.privateKey.fill(0)
    setIdentity(null); setPhrase(''); setChallenge(null); setAnswers(['', '', '']); setError(''); setStep('start')
  }
  const complete = async (result: Identity) => {
    setBusy(true)
    try {
      const store = await openStore(result)
      storeRef.current?.close(); storeRef.current = store; identityRef.current = result
      setIdentity(result); setPhrase(''); setChallenge(null); setAnswers(['', '', '']); setError(''); setStep('done')
    } catch (cause) { result.privateKey.fill(0); setError(cause instanceof Error ? cause.message : '无法保存身份，请重试') }
    finally { setBusy(false) }
  }
  if (homeworkPage && storeRef.current && identity) return <><div hidden><BackupSettings identity={identity} store={storeRef.current} /><LedgerSettings identity={identity} store={storeRef.current} /></div><Suspense fallback={<p>正在打开今日作业…</p>}><HomeworkPage store={storeRef.current} onBack={()=>setHomeworkPage(false)} /></Suspense></>
  if (intakePage && storeRef.current && identity) return <><div hidden><BackupSettings identity={identity} store={storeRef.current} /><LedgerSettings identity={identity} store={storeRef.current} /></div><Suspense fallback={<p>正在打开采集页…</p>}><IntakePage store={storeRef.current} identity={identity} onBack={()=>setIntakePage(false)} /></Suspense></>
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '24px 16px', maxWidth: 480, margin: '0 auto' }}>
      <h1>知衡 · 身份</h1>
      <p>请用生成时的同一种文字恢复</p>
      <p>身份由设备密钥加密保存在本机，重新打开可自动解锁。浏览器数据被清空后，请用助记词恢复；业务数据还需从备份恢复。请妥善抄写，不要交给他人。</p>
      <details><summary>设置</summary><h2>存储状态</h2><p role="status">{persistenceLabels[persistence]}</p><p>持久化存储不能替代备份。</p>{identity && storeRef.current && <><BackupSettings identity={identity} store={storeRef.current} /><LedgerSettings identity={identity} store={storeRef.current} /></>}</details>
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
        try { await complete(restoreIdentity(phrase)) } catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败') }
      }}>
        <label>输入 12 个词（中文可连写，英文用空格或标点分隔，自动识别文字）<textarea rows={5} style={{ width: '100%', boxSizing: 'border-box' }} autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={event => setPhrase(event.target.value)} /></label>
        <button type="submit" disabled={busy}>校验并恢复</button>
      </form>}
      {step === 'done' && identity && <>
        <h2>身份已就绪</h2>
        <p><button onClick={()=>setHomeworkPage(true)}>今日作业</button></p>
        <PushSettings identity={identity} />
        <p>词表：{languageLabels[identity.language]} · 账户：{identity.account}（本人）</p>
        <p style={{ overflowWrap: 'anywhere' }}>公钥 npub：{identity.npub}</p>
        <p style={{ overflowWrap: 'anywhere' }}>公钥十六进制：{identity.publicKey}</p>
        <section>
          <h2>看诊前采集</h2>
          <p>用输入法的语音输入，把不舒服说清楚。急症筛查只在本地进行；点“确认发送”之前，没有任何数据离开手机。M1-05 接通中继后才会真正交给老师。</p>
          <p><button type="button" onClick={() => setIntakePage(true)}>开始采集</button></p>
        </section>
      </>}
      {step !== 'start' && <p><button disabled={busy} onClick={reset}>{step === 'done' ? '返回首页' : '取消并返回'}</button></p>}
    </main>
  )
}
