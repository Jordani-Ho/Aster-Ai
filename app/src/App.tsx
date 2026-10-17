import { useState } from 'react'
import { createIdentity, generatePhrase, languages, languageLabels, restoreIdentity } from './core/identity'
import type { Identity, Language } from './core/identity'
import { beginBackup, checkBackup } from './core/identity/backup'
import type { BackupChallenge } from './core/identity/backup'

export function App() {
  const [language, setLanguage] = useState<Language>('simplified')
  const [step, setStep] = useState<'start' | 'write' | 'check' | 'restore' | 'done'>('start')
  const [phrase, setPhrase] = useState('')
  const [challenge, setChallenge] = useState<BackupChallenge | null>(null)
  const [answers, setAnswers] = useState(['', '', ''])
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [error, setError] = useState('')
  const reset = () => {
    identity?.privateKey.fill(0)
    setIdentity(null); setPhrase(''); setChallenge(null); setAnswers(['', '', '']); setError(''); setStep('start')
  }
  const complete = (result: Identity) => {
    setIdentity(result); setPhrase(''); setChallenge(null); setAnswers(['', '', '']); setError(''); setStep('done')
  }
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '24px 16px', maxWidth: 480, margin: '0 auto' }}>
      <h1>知衡 · 身份</h1>
      <p>请用生成时的同一种文字恢复</p>
      <p>身份仅保存在本次页面内存中，刷新或关闭后需用助记词恢复。请妥善抄写，不要交给他人。</p>
      {error && <p role="alert">{error}</p>}
      {step === 'start' && <>
        <label>助记词文字 <select value={language} onChange={event => setLanguage(event.target.value as Language)}>{languages.map(item => <option key={item} value={item}>{languageLabels[item]}</option>)}</select></label>
        <p><button onClick={() => { try { setPhrase(generatePhrase(language)); setStep('write') } catch { setError('无法生成身份，请使用支持安全随机数的浏览器') } }}>生成新身份</button></p>
        <button onClick={() => setStep('restore')}>使用助记词恢复</button>
      </>}
      {step === 'write' && <>
        <h2>按顺序抄写 12 个词</h2>
        <ol>{phrase.split(' ').map((word, index) => <li key={index}>{word}</li>)}</ol>
        <button onClick={() => { setChallenge(beginBackup(phrase)); setStep('check') }}>我已抄写，开始核对</button>
      </>}
      {step === 'check' && challenge && <form onSubmit={event => {
        event.preventDefault()
        if (!checkBackup(challenge, answers)) { setError('核对不通过，请检查抄写的词及顺序'); return }
        try { complete(createIdentity(phrase, language)) } catch { setError('身份生成失败，请重新开始') }
      }}>
        <h2>核对抄写</h2>
        {challenge.positions.map((position, index) => <p key={position}><label>第 {position + 1} 个词 <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={answers[index]} onChange={event => setAnswers(previous => previous.map((answer, i) => i === index ? event.target.value : answer))} /></label></p>)}
        <button type="submit">核对并完成</button>
      </form>}
      {step === 'restore' && <form onSubmit={event => {
        event.preventDefault()
        try { complete(restoreIdentity(phrase)) } catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败') }
      }}>
        <label>输入 12 个词（用空格分隔，自动识别文字）<textarea rows={5} style={{ width: '100%', boxSizing: 'border-box' }} autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={event => setPhrase(event.target.value)} /></label>
        <button type="submit">校验并恢复</button>
      </form>}
      {step === 'done' && identity && <>
        <h2>身份已就绪</h2>
        <p>词表：{languageLabels[identity.language]} · 账户：{identity.account}（本人）</p>
        <p style={{ overflowWrap: 'anywhere' }}>公钥 npub：{identity.npub}</p>
        <p style={{ overflowWrap: 'anywhere' }}>公钥十六进制：{identity.publicKey}</p>
      </>}
      {step !== 'start' && <p><button onClick={reset}>{step === 'done' ? '清除本次身份并返回' : '取消并返回'}</button></p>}
    </main>
  )
}
