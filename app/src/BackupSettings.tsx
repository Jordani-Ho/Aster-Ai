import { useEffect, useRef, useState } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import { createBackupManager, type BackupStatus } from './core/backup'
import { communityBackupRelay } from './core/backup/relay'
const defaults=((import.meta as ImportMeta&{env:Record<string,string|undefined>}).env.VITE_COMMUNITY_RELAYS??'').split(',').map(value=>value.trim()).filter(Boolean)
export function BackupSettings({identity,store}:{identity:Identity;store:LocalStore}) {
 const [status,setStatus]=useState<BackupStatus>({result:'never'}),[error,setError]=useState(''),[message,setMessage]=useState('')
 const [relaysText,setRelaysText]=useState(defaults.join('\n')),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false),[monthly,setMonthly]=useState(true),[replace,setReplace]=useState(false)
 const managerRef=useRef<ReturnType<typeof createBackupManager>|null>(null)
 useEffect(()=>{
  let disposed=false,manager:ReturnType<typeof createBackupManager>|undefined,relay:ReturnType<typeof communityBackupRelay>|undefined,pending=false
  const tick=async()=>{
   if(pending||!manager||disposed)return
   pending=true;setBusy(true)
   try{await manager.ensureDaily();if(!disposed)setError('')}
   catch{if(!disposed)setError('自动备份未成功，下次打开应用会重试；也可先导出备份文件。')}
   finally{if(!disposed){setStatus(await manager.status());setMonthly(await manager.monthlyFileDue());setBusy(false)}pending=false}
  }
  void (async()=>{
   const rows=await store.list('backup-config'),value=rows[0]?.value as {relays?:unknown}|undefined
   const urls=Array.isArray(value?.relays)&&value.relays.every(item=>typeof item==='string')?value.relays as string[]:defaults
   if(disposed)return
   setRelaysText(urls.join('\n'))
   relay=communityBackupRelay(identity,urls);manager=createBackupManager({identity,store,relay});managerRef.current=manager
   await tick()
  })().catch(()=>{if(!disposed){setError('备份中继配置无效，请检查后保存。');setBusy(false)}})
  const timer=setInterval(()=>void tick(),60*60*1000),focus=()=>void tick()
  window.addEventListener('focus',focus)
  return()=>{disposed=true;clearInterval(timer);window.removeEventListener('focus',focus);manager?.close();relay?.close();managerRef.current=null}
 },[identity,store,revision])
 const refresh=async()=>{const manager=managerRef.current;if(manager){setStatus(await manager.status());setMonthly(await manager.monthlyFileDue())}}
 const run=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');setMessage('');try{await action();await refresh()}catch(cause){setError(cause instanceof Error?cause.message:'备份操作失败，请重试')}finally{setBusy(false)}}
 const configure=()=>run(async()=>{
  const relays=relaysText.split(/[\s,]+/).filter(Boolean)
  const probe=communityBackupRelay(identity,relays);probe.close()
  const rows=await store.list('backup-config');await store.put('backup-config',rows[0]?.key??crypto.randomUUID(),{relays});setRevision(value=>value+1)
 })
 const download=()=>run(async()=>{
  if(!managerRef.current)throw Error('备份设置尚未就绪')
  const text=await managerRef.current.exportFile(),url=URL.createObjectURL(new Blob([text],{type:'application/json'}))
  const anchor=document.createElement('a');anchor.href=url;anchor.download='zhiheng-encrypted-backup.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  setMessage('已生成加密备份文件，请确认下载并妥善保存。')
 })
 return <details><summary>备份状态</summary>
  <p>中继备份默认开启，每天在应用打开时检查。照片只保存在本机和你导出的备份文件中。</p>
  <p role="status">{status.result==='success'?'最近一次备份成功':status.result==='restored'?'已恢复本地数据':status.result==='failed'?'备份失败，等待重试':'尚未完成备份'}{status.lastSuccess&&` · ${new Date(status.lastSuccess).toLocaleString()}`}</p>
  {status.lastRestore&&<p>最近恢复：{new Date(status.lastRestore).toLocaleString()}</p>}
  {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {monthly&&<p>本月请导出一次加密备份文件，照片也会包含在内。</p>}
  <label>社区备份中继（每行一个WSS地址）<textarea rows={2} value={relaysText} onChange={e=>setRelaysText(e.target.value)} style={{width:'100%',boxSizing:'border-box'}}/></label>
  {!relaysText.trim()&&<p>社区备份中继尚未配置，自动备份暂不可用。</p>}
  <p><button disabled={busy} onClick={()=>void configure()}>保存中继设置</button>{' '}<button disabled={busy||!relaysText.trim()} onClick={()=>void run(async()=>{if(!managerRef.current)throw Error('备份尚未就绪');await managerRef.current.backupNow();setMessage('中继备份成功')})}>立即备份</button></p>
  <p><button disabled={busy} onClick={()=>void download()}>导出加密备份文件（含照片）</button></p>
  <p>恢复会替换本机全部业务数据。中继备份不含照片；如果本机仍有照片，请先导出文件。</p>
  <label><input type="checkbox" checked={replace} onChange={e=>setReplace(e.target.checked)}/>我已保存需要保留的本机资料，允许替换</label>
  <p><button disabled={busy||!replace} onClick={()=>void run(async()=>{if(!managerRef.current)throw Error('备份尚未就绪');await managerRef.current.restoreLatest(true);setMessage('已从中继恢复')})}>从中继恢复最新备份</button></p>
  <label>从加密备份文件恢复<input type="file" accept="application/json,.json" disabled={busy||!replace} onChange={event=>{
   const file=event.target.files?.[0];if(!file)return
   void run(async()=>{if(file.size>64*1024*1024)throw Error('备份文件超过64MB，请在容量充足的设备恢复');if(!managerRef.current)throw Error('备份尚未就绪');await managerRef.current.restoreFile(await file.text(),true);setMessage('已从加密文件恢复')})
   event.target.value=''
  }}/></label>
 </details>
}
