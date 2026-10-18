import { useEffect, useState } from 'react'
import type {Identity} from './core/identity'
import {restoreIdentity} from './core/identity'
import {beginBackup,checkBackup,type BackupChallenge} from './core/identity/backup'
import type {LocalStore} from './core/store'
export function AdvancedRecovery({store,onRestore}:{store?:LocalStore;onRestore:(identity:Identity)=>Promise<void>}){
 const [words,setWords]=useState(''),[input,setInput]=useState(''),[challenge,setChallenge]=useState<BackupChallenge|null>(null),[answers,setAnswers]=useState(['','','']),[replace,setReplace]=useState(false),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
 useEffect(()=>{if(!store)return;void store.get('recovery-words','self').then(v=>setWords((v as {words?:string})?.words??'')).catch(()=>{})},[store])
 return <details><summary>换手机时用（高级）</summary>
 <p>恢复资料只交给自己保管。恢复会替换这台设备上的资料，先导出需要保留的备份文件。</p>
 {words&&<details><summary>显示恢复资料</summary><p>按顺序抄写这12个词，放在只有你知道的地方。</p><ol>{words.split(' ').map((word,i)=><li key={i}>{word}</li>)}</ol><button onClick={()=>setChallenge(beginBackup(words))}>我已抄写，开始核对</button>
 {challenge&&<form onSubmit={e=>{e.preventDefault();setMessage(checkBackup(challenge,answers)?'核对完成，请妥善保存。':'核对不通过，请检查顺序。')}}>{challenge.positions.map((position,i)=><label key={position}>第{position+1}个词<input value={answers[i]} onChange={e=>setAnswers(values=>values.map((v,n)=>n===i?e.target.value:v))}/></label>)}<button>核对备份</button></form>}</details>}
 <form onSubmit={e=>{e.preventDefault();if(!replace||busy)return;setBusy(true);void(async()=>{try{const restored=restoreIdentity(input);await onRestore(restored)}catch{setMessage('恢复未成功，请检查这12个词及顺序。')}finally{setBusy(false)}})()}}>
 <label>输入12个词<textarea value={input} onChange={e=>setInput(e.target.value)} autoComplete="off"/></label>
 <label><input type="checkbox" checked={replace} onChange={e=>setReplace(e.target.checked)}/>我已保存需要保留的资料，允许替换</label><button disabled={!replace||busy}>恢复我的资料</button></form>{message&&<p role="status">{message}</p>}
 </details>
}
