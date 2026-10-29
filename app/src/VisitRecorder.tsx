import { useEffect, useRef, useState } from 'react'
import type { LocalStore } from './core/store'
import { appendVisitAudioChunk } from './core/record/visit-audio'
import { appendVisitOriginal } from './core/record/visit-originals'
import { createVisitSpeech, type RecognitionPort, type VisitLanguage, type VisitSpeech } from './core/record/visit-speech'

/** 面诊录音与可替换识别器；录音分块只写本机。 */
export function VisitRecorder({ store, visitId, onChange, onRecording, onStopped, stopRequest }: {
  store:LocalStore; visitId:string; onChange:()=>void; onRecording:(value:boolean)=>void; onStopped:()=>void; stopRequest:number
}) {
  const [recording,setRecording]=useState(false), [busy,setBusy]=useState(false), [seconds,setSeconds]=useState(0)
  const [language,setLanguage]=useState<VisitLanguage>('zh-CN'), [notice,setNotice]=useState('')
  const media=useRef<MediaRecorder|null>(null), stream=useRef<MediaStream|null>(null), speech=useRef<VisitSpeech|null>(null)
  const queue=useRef<Promise<void>>(Promise.resolve()), started=useRef(0), stopping=useRef(false), mounted=useRef(true)
  const changed=useRef(onChange), report=useRef(onRecording), stopped=useRef(onStopped); changed.current=onChange; report.current=onRecording; stopped.current=onStopped
  useEffect(()=>{let live=true;void store.get('settings','visit-speech-language').then(v=>{if(live&&(v==='zh-CN'||v==='yue-Hant-HK'))setLanguage(v)}).catch(()=>{});return()=>{live=false}},[store])
  useEffect(()=>{if(!recording)return;const timer=setInterval(()=>setSeconds(Math.floor((Date.now()-started.current)/1000)),1000);return()=>clearInterval(timer)},[recording])
  const stop=()=>{if(stopping.current)return;const current=media.current;if(!current)return;stopping.current=true;speech.current?.stop();if(current.state!=='inactive')current.stop()}
  useEffect(()=>{
    const hidden=()=>{if(document.visibilityState==='hidden')stop()}
    const leaving=(event:BeforeUnloadEvent)=>{if(media.current?.state==='recording'){event.preventDefault();event.returnValue=''}}
    document.addEventListener('visibilitychange',hidden);window.addEventListener('beforeunload',leaving)
    mounted.current=true
    return()=>{mounted.current=false;document.removeEventListener('visibilitychange',hidden);window.removeEventListener('beforeunload',leaving);stop()}
  },[])
  useEffect(()=>{if(stopRequest>0)stop()},[stopRequest])
  const start=async()=>{
    if(busy||media.current)return
    setBusy(true);setNotice('')
    try {
      if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw Error('这台设备不能录音，请直接打字。')
      const microphone=await navigator.mediaDevices.getUserMedia({audio:true})
      if(!mounted.current || document.visibilityState==='hidden') { microphone.getTracks().forEach(track=>track.stop()); return }
      stream.current=microphone
      const recorder=new MediaRecorder(microphone), segment=crypto.randomUUID().replaceAll('-','').slice(0,16)
      let speechFinished!:()=>void
      const speechDone=new Promise<void>(resolve=>{speechFinished=resolve})
      let saveFailed=false
      media.current=recorder; stopping.current=false;started.current=Date.now();setSeconds(0)
      const append=(action:()=>Promise<void>)=>{queue.current=queue.current.then(action).catch(()=>{saveFailed=true;setNotice('本机保存失败，请检查存储空间。')})}
      recorder.ondataavailable=event=>{if(event.data.size)append(async()=>{await appendVisitAudioChunk(store,visitId,segment,recorder.mimeType||event.data.type,new Uint8Array(await event.data.arrayBuffer()))})}
      recorder.onerror=()=>{setNotice('录音中断，已保存的内容仍在本机。');stop()}
      microphone.getAudioTracks().forEach(track=>{track.onended=()=>{setNotice('话筒已断开，已保存的内容仍在本机。');stop()}})
      recorder.onstop=()=>{
        speech.current?.stop()
        microphone.getTracks().forEach(track=>track.stop());stream.current=null;media.current=null
        void (async()=>{
          let timer: ReturnType<typeof setTimeout> | undefined
          const ended=await Promise.race([speechDone.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),10000)})])
          if(timer!==undefined)clearTimeout(timer)
          await queue.current
          setRecording(false);report.current(false);changed.current()
          if(!ended) setNotice('语音识别尚未结束，请核对原话后手动整理。')
          else if(!saveFailed) stopped.current()
        })()
      }
      recorder.start(5000)
      setRecording(true);report.current(true)
      const host=window as unknown as { SpeechRecognition?:new()=>RecognitionPort; webkitSpeechRecognition?:new()=>RecognitionPort }
      const Constructor=host.SpeechRecognition??host.webkitSpeechRecognition
      speech.current=createVisitSpeech(Constructor?()=>new Constructor():null,{
        onFinal:text=>append(async()=>{await appendVisitOriginal(store,visitId,text);changed.current()}),
        onError:error=>{setNotice('语音识别暂不可用，录音照录；可以用输入法话筒或直接打字。');if(error==='unsupported'||error==='start-failed'||error==='restart-failed')speechFinished()},
        onEnd:speechFinished,
      })
      speech.current.start(language)
    } catch(cause) {
      stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;media.current=null
      setNotice(cause instanceof DOMException && (cause.name==='NotAllowedError'||cause.name==='SecurityError') ? '请在浏览器设置里允许使用话筒，再试一次。' : cause instanceof Error ? cause.message : '录音没开，请检查话筒。')
    } finally { setBusy(false) }
  }
  return <section aria-label="面诊录音">
    <p className="nl-quiet">转文字时，声音会经过浏览器的识别服务；录音只留在本机。</p>
    <label>识别语言<select aria-label="识别语言" value={language} disabled={recording||busy} onChange={event=>{const value=event.target.value as VisitLanguage;setLanguage(value);void store.put('settings','visit-speech-language',value)}}><option value="zh-CN">普通话</option><option value="yue-Hant-HK">粤语</option></select></label>
    {recording&&<p role="status">🔴 正在录音 · {Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</p>}
    {notice&&<p role="status">{notice}</p>}
    <button type="button" className="nl-primary" disabled={busy} onClick={()=>recording?stop():void start()}>{recording?'停止录音':'开始录音'}</button>
  </section>
}
