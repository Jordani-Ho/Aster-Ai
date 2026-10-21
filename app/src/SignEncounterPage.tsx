import { useEffect, useState } from 'react'
import type { Encounter, Source } from './core/record/types'
import { acceptDraftForSigning } from './core/record/sign'
import { isLongRecord } from './core/record/fold'
import { OBSERVATION_CHOICES, type ObservationChoice, type ObservationNote } from './core/kangbi'
import './sign-encounter.css'
const labels:Record<Source,string>={student:'学生陈述',teacher:'老师判断',ai_draft:'AI 草稿',external:'外部证据',unknown:'未知'}
const sectionKeys=['intake','fourExams','judgment','plan','outcome','homework'] as const
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
  onConfirm:(encounter:Encounter, comparison?:ObservationNote)=>Promise<void>|void
  onCancel?:()=>void
  onRevise?:(encounter:Encounter,instruction:string)=>Promise<Encounter>
  /** V2-10：老师签字前自己选“和上次比”；不选也能签字，记为未评价（不是持平）。 */
  comparison?:ObservationNote
  onComparisonChange?:(value:ObservationChoice|null)=>void
}
// 仅展示与真人确认；模型调用由起草父组件提供，签字处理从不调用 onRevise。
export function SignEncounterPage({initial,onConfirm,onCancel,onRevise,comparison=null,onComparisonChange}:SignEncounterPageProps){
  const [encounter,setEncounter]=useState(initial),[instruction,setInstruction]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  // V2-13：长病历分段折叠；默认只展开“学生陈述”，可逐段点开或一键展开/收起。
  const folded = isLongRecord(encounter)
  const [manualOpen,setManualOpen]=useState<Record<string,boolean>>({})
  useEffect(()=>{setManualOpen({})},[encounter.version,folded])
  const isOpen=(key:string)=>manualOpen[key] ?? (key==='intake'||!folded)
  const toggle=(key:string,open:boolean)=>setManualOpen(previous=>({...previous,[key]:open}))
  const expandAll=()=>setManualOpen(Object.fromEntries(sectionKeys.map(key=>[key,true])))
  const collapseAll=()=>setManualOpen(Object.fromEntries(sectionKeys.map(key=>[key,key==='intake'])))
  const fieldSections=([['fourExams','四诊'],['judgment','判断'],['plan','处理'],['outcome','结果']] as const).filter(([key])=>Boolean(encounter[key])).map(([key,title])=>({
    key:key as string,title,render:<>
      {(Object.entries(encounter[key]!).filter((entry): entry is [string, import('./core/record/types').Field<string> | import('./core/record/types').Field<import('./core/record/types').Prescription>] => entry[0]!=='homework' && !Array.isArray(entry[1])).map(([fieldKey,field])=><div className="sign-field" key={fieldKey}><div className="sign-field-head"><h2>{fields[fieldKey]}</h2><span className={'source source-'+field.source}>{labels[field.source as Source]}</span></div><p className="sign-value">{display(field.value)}</p></div>))}
    </>,
  }))
  const sectionDefinitions=[
    {key:'intake',title:'学生陈述',render:<>
      {(['chiefComplaint','presentIllness','history','medsAllergies'] as const).map((key,i)=><p key={key}>{['主诉','现病史','既往史','用药与过敏'][i]}：{encounter.intake[key].value??'未知'}</p>)}<p>照片：{encounter.intake.attachments.length} 张</p>
    </>},
    ...fieldSections,
    {key:'homework',title:'作业',render:encounter.plan.homework.length===0?<p>暂无</p>:<>{encounter.plan.homework.map(h=><div className="sign-field" key={h.id}><h3>{h.title}</h3><p>{h.detail}</p><p>{scheduleLabel(h.schedule)}{h.durationDays?' · '+h.durationDays+'天':''}</p><span className={'source source-'+h.source}>{labels[h.source]}</span></div>)}</>},
  ]
  return <main className="sign-page">
    <header className="sign-head"><h1>病历草稿</h1><p>看过整张卡片后，按“签字发出”确认全部内容。</p></header>
    <article className="draft-card" aria-label="完整病历卡片" data-long-record={folded?'yes':'no'}>
      {folded&&<div className="sign-fold-bar">
        <p>这份病历较长，已分段折叠。点每段标题展开。</p>
        <div className="sign-fold-actions"><button type="button" onClick={expandAll}>展开全部</button><button type="button" onClick={collapseAll}>收起全部</button></div>
      </div>}
      {sectionDefinitions.filter(section=>section.key==='intake'||section.key==='homework'||Boolean(encounter[section.key as 'fourExams'|'judgment'|'plan'|'outcome'])).map(section=>
        <details key={section.key} className="sign-section" open={isOpen(section.key)} onToggle={event=>toggle(section.key,event.currentTarget.open)}>
          <summary><h2>{section.title}</h2></summary>
          <div className="sign-section-body">{section.render}</div>
        </details>)}
    </article>
    {onRevise&&<form className="sign-editor" onSubmit={event=>{event.preventDefault();if(busy||!instruction.trim())return;setBusy(true);setError('');void onRevise(encounter,instruction).then(next=>{setEncounter(next);setInstruction('')}).catch(cause=>setError(cause instanceof Error?cause.message:'改稿未完成，请重试。')).finally(()=>setBusy(false))}}>
      <label>说说怎么改<textarea rows={2} value={instruction} disabled={busy} onChange={e=>setInstruction(e.target.value)} placeholder="用键盘话筒说话，或打字：去掉某味药、作业改成每晚泡脚"/></label><button disabled={busy||!instruction.trim()}>按意见改稿</button>
    </form>}
    <footer className="sign-foot">{error&&<p role="alert">{error}</p>}
      {onComparisonChange&&<section className="sign-compare" aria-label="和上次比">
        <p>和上次比：</p>
        <div className="sign-compare-options" role="group" aria-label="和上次比">
          {OBSERVATION_CHOICES.map(choice=><button type="button" key={choice.value} aria-pressed={comparison===choice.value} disabled={busy} onClick={()=>onComparisonChange(comparison===choice.value?null:choice.value)}>{choice.label}</button>)}
        </div>
        <p className="sign-compare-note">不选也能签字，记为未评价（不是持平）。</p>
      </section>}
      <div className="sign-actions"><button className="sign-primary" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await onConfirm(acceptDraftForSigning(encounter),comparison??null)}catch(cause){setError(cause instanceof Error?cause.message:'发出未完成，请重试。')}finally{setBusy(false)}}}>签字发出</button>{onCancel&&<button disabled={busy} onClick={onCancel}>返回</button>}</div></footer>
  </main>
}
