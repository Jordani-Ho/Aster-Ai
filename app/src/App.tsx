<<<<<<< HEAD
import './homework.css'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
=======
import { PushSettings } from './PushSettings'
import { useEffect, useRef, useState } from 'react'
>>>>>>> bfd9656 (feat(push): add authenticated Web Push subscriptions and fixed reminders)
import { createIdentity, generatePhrase, languages, languageLabels, restoreIdentity } from './core/identity'
import type { Identity, Language } from './core/identity'
import { beginBackup, checkBackup } from './core/identity/backup'
import type { BackupChallenge } from './core/identity/backup'
import { check, detectRegion } from './core/redflags'
import type { RedFlagResult } from './core/redflags'
import { openStore, resumeStore, type LocalStore } from './core/store'
import { persistenceLabels, requestPersistence, type PersistenceStatus } from './core/store/persistence'
import { RedFlagAlert } from './RedFlagAlert'

const HomeworkPage = lazy(() => import('./HomeworkPage').then(module => ({ default: module.HomeworkPage })))

function recordId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function App() {
  const [homeworkPage, setHomeworkPage] = useState(false)
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
  const [talk, setTalk] = useState('')
  const [alert, setAlert] = useState<RedFlagResult | null>(null)
  const [notice, setNotice] = useState('')
  const storeRef = useRef<LocalStore | null>(null)
  const identityRef = useRef<Identity | null>(null)
  const region = detectRegion(navigator.language)
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
    setIdentity(null); setPhrase(''); setChallenge(null); setAnswers(['', '', '']); setError(''); setStep('start'); setTalk(''); setAlert(null); setNotice('')
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
  const runCheck = () => {
    const result = check(talk)
    if (!result.hit) { setAlert(null); setNotice('没有发现急症信号。这是本地筛查，不能替代医生判断。'); return }
    setNotice(''); setAlert(result)
  }
  const notifyTeacher = () => {
    const category = alert?.category
    if (!category) return
    setNotice('已记录，等中继接通后再发送。')
    void storeRef.current?.put('redflag-notify', recordId(), { categoryId: category.id, action: category.action, at: new Date().toISOString() })
  }
  const dismissAlert = () => {
    const category = alert?.category
    setAlert(null); setNotice('')
    if (!category) return
    void storeRef.current?.put('redflag-log', recordId(), { categoryId: category.id, action: category.action, at: new Date().toISOString(), region: region ?? 'unknown' })
  }
  if (homeworkPage && storeRef.current && identity) return <Suspense fallback={<p>正在打开今日作业…</p>}><HomeworkPage store={storeRef.current} onBack={()=>setHomeworkPage(false)} /></Suspense>
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '24px 16px', maxWidth: 480, margin: '0 auto' }}>
      <h1>知衡 · 身份</h1>
      <p>请用生成时的同一种文字恢复</p>
      <p>身份由设备密钥加密保存在本机，重新打开可自动解锁。浏览器数据被清空后，请用助记词恢复；业务数据还需从备份恢复。请妥善抄写，不要交给他人。</p>
      <details><summary>设置</summary><h2>存储状态</h2><p role="status">{persistenceLabels[persistence]}</p><p>持久化存储不能替代备份。备份功能尚未接入。</p></details>
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
<<<<<<< HEAD
        <p><button onClick={()=>setHomeworkPage(true)}>今日作业</button></p>
=======
        <PushSettings identity={identity} />
>>>>>>> bfd9656 (feat(push): add authenticated Web Push subscriptions and fixed reminders)
        <p>词表：{languageLabels[identity.language]} · 账户：{identity.account}（本人）</p>
        <p style={{ overflowWrap: 'anywhere' }}>公钥 npub：{identity.npub}</p>
        <p style={{ overflowWrap: 'anywhere' }}>公钥十六进制：{identity.publicKey}</p>
        <section>
          <h2>急症自检</h2>
          <p>写下现在的感受。检查只在本地进行：不联网、不调用大模型，结果可以复现。M1-09 接入采集流程后，这个临时入口会被替换。</p>
          <label>现在的感受<textarea rows={3} style={{ width: '100%', boxSizing: 'border-box' }} value={talk} onChange={event => setTalk(event.target.value)} /></label>
          <p><button type="button" onClick={runCheck} disabled={!talk.trim()}>检查</button></p>
          {notice && <p role="status">{notice}</p>}
        </section>
      </>}
      {step !== 'start' && <p><button disabled={busy} onClick={reset}>{step === 'done' ? '返回首页' : '取消并返回'}</button></p>}
      {alert && <RedFlagAlert result={alert} region={region} status={notice} onNotifyTeacher={notifyTeacher} onDismiss={dismissAlert} />}
    </main>
  )
}
