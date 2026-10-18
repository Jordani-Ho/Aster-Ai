import { useState } from 'react'
import type { Encounter, Source } from './core/record/types'
import { acceptDraftForSigning } from './core/record/sign'
import { VideoCapture } from './PracticeVideo'
import './sign-encounter.css'
const labels:Record<Source,string>={student:'学生陈述',teacher:'老师判断',ai_draft:'AI 草稿',external:'外部证据',unknown:'未知'}
const fields:Record<string,string>={look:'望',listenSmell:'闻',ask:'问',pulse:'切',symptomSummary:'症状摘要',pattern:'证候',mechanism:'病机',rationale:'辨证依据',principle:'治则治法',prescription:'方子',advice:'医嘱',change:'变化',adverse:'不良反应',next:'下次计划'}
function display(value:unknown):string {
  if(value==null)return '未知'
  if(typeof value==='string')return value
  const p=value as Encounter['plan']['prescription']['value']
  if(p&&Array.isArray(p.items))return p.items.map(i=>i.herb+' '+i.dose+(i.note?'（'+i.note+'）':'')).join('、')+(p.method?'；'+p.method:'')+(p.days?'；'+p.days+'天':'')+(p.changeReason?'；加减理由：'+p.changeReason:'')
  return JSON.stringify(value)
}
function scheduleLabel(spec: Encounter['plan']['homework'][number]['schedule']): string {
  switch (spec.kind) {
    case 'daily': return '每天 '+spec.time
    case 'shichen': return spec.shichen+'时'
    case 'jieqi': return spec.jieqi
    case 'once': return spec.date+(spec.time?' '+spec.time:'')
    // M1-23a 随习惯作业：不按钟点，只提示嵌进哪个日常习惯。
    case 'habit': return '随习惯：'+spec.anchor
  }
}
export interface SignEncounterPageProps {
  initial:Encounter
  onConfirm:(encounter:Encounter)=>Promise<void>|void
  onCancel?:()=>void
  onRevise?:(encounter:Encounter,instruction:string)=>Promise<Encounter>
  onVideoChange?:(encounter:Encounter,homework:string,file?:File)=>Promise<Encounter>
}
// 仅展示与真人确认；模型调用由起草父组件提供，签字处理从不调用 onRevise。
export function SignEncounterPage({initial,onConfirm,onCancel,onRevise,onVideoChange}:SignEncounterPageProps){
  const [encounter,setEncounter]=useState(initial),[instruction,setInstruction]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(false)
  const changeVideo=(homework:string,file?:File)=>{if(!onVideoChange||busy||retry)return;setBusy(true);setError('');void onVideoChange(encounter,homework,file).then(setEncounter).catch(cause=>setError(cause instanceof Error?cause.message:'视频未完成，请重试')).finally(()=>setBusy(false))}
  return <main className="sign-page">
    <header className="sign-head"><h1>病历草稿</h1><p>看过整张卡片后，按“签字发出”确认全部内容。</p></header>
    <article className="draft-card" aria-label="完整病历卡片">
      <section><h2>学生陈述</h2>{(['chiefComplaint','presentIllness','history','medsAllergies'] as const).map((key,i)=><p key={key}>{['主诉','现病史','既往史','用药与过敏'][i]}：{encounter.intake[key].value??'未知'}</p>)}<p>照片：{encounter.intake.attachments.length} 张</p></section>
      {[encounter.fourExams,encounter.judgment,encounter.plan,encounter.outcome].filter(Boolean).map((section,i)=><section key={i}>
        {Object.entries(section!).filter((entry): entry is [string, import('./core/record/types').Field<string> | import('./core/record/types').Field<import('./core/record/types').Prescription>] => entry[0]!=='homework' && !Array.isArray(entry[1])).map(([key,field])=><div className="sign-field" key={key}><div className="sign-field-head"><h2>{fields[key]}</h2><span className={'source source-'+field.source}>{labels[field.source as Source]}</span></div><p className="sign-value">{display(field.value)}</p></div>)}
      </section>)}
      <section><h2>作业</h2>{encounter.plan.homework.length===0?<p>暂无</p>:encounter.plan.homework.map(h=><div className="sign-field" key={h.id}><h3>{h.title}</h3><p>{h.detail}</p><p>{scheduleLabel(h.schedule)}{h.durationDays?' · '+h.durationDays+'天':''}</p><span className={'source source-'+h.source}>{labels[h.source]}</span>{onVideoChange&&<>{h.video?<p>练习视频已准备 · {Math.round(h.video.duration)} 秒 <button type="button" disabled={busy||retry} onClick={()=>changeVideo(h.id)}>移除视频</button></p>:<VideoCapture label="拍练习视频" busy={busy||retry} onFile={file=>changeVideo(h.id,file)}/>}<small>视频先安全暂存，签字时只交给这位学生。交还后本机删除。</small></>}</div>)}</section>
    </article>
    {onRevise&&<form className="sign-editor" onSubmit={event=>{event.preventDefault();if(busy||retry||!instruction.trim())return;setBusy(true);setError('');void onRevise(encounter,instruction).then(next=>{if(encounter.plan.homework.some(h=>h.video&&!next.plan.homework.some(n=>n.video?.sha256===h.video?.sha256)))setError('作业已改，原视频已移除；请给新作业重新添加视频。');setEncounter(next);setInstruction('')}).catch(cause=>setError(cause instanceof Error?cause.message:'改稿未完成，请重试。')).finally(()=>setBusy(false))}}>
      <label>说说怎么改<textarea rows={2} value={instruction} disabled={busy||retry} onChange={e=>setInstruction(e.target.value)} placeholder="用键盘话筒说话，或打字：去掉某味药、作业改成每晚泡脚"/></label><button disabled={busy||retry||!instruction.trim()}>按意见改稿</button>
    </form>}
    <footer className="sign-foot">{error&&<p role="alert">{error}</p>}<div className="sign-actions"><button className="sign-primary" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await onConfirm(acceptDraftForSigning(encounter))}catch(cause){setRetry(true);setError(cause instanceof Error?cause.message:'发出未完成，请重试。')}finally{setBusy(false)}}}>{retry?'重发交还':'签字发出'}</button>{onCancel&&<button disabled={busy||retry} onClick={onCancel}>返回</button>}</div></footer>
  </main>
}
