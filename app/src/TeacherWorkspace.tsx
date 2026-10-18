import { DailyMirrorCard } from './DailyMirrorCard'
import { TeacherCarePlan } from './TeacherCarePlan'
import { TemplateSettings } from './TemplateSettings'
import { useState, useEffect, type ReactNode } from 'react'
import type { Identity } from './core/identity'
import type { LocalStore } from './core/store'
import type { Wiring } from './core/wiring'
import type { LlmClient } from './core/llm'
import { listConsults, listStudentAdherence, type StoredConsult, type StudentAdherence } from './core/inbox'
import { rankStudentAdherence } from './core/adherence'
import { localDay } from './core/homework/schedule'
import { prioritizeConsults,urgentConsult } from './core/inbox/priority'
import { TeacherInboxPage } from './TeacherInboxPage'
import { InPersonPage } from './InPersonPage'
import { InviteSettings } from './InviteSettings'
import './teacher.css'
type Tab='今天'|'面诊'|'远程'|'管理'
export function TeacherWorkspace({identity,store,stack,llm,gateway,settings,status,ledgerPanel,mirror,renderCarePlan}:{identity:Identity;store:LocalStore;stack:Wiring|null;llm:LlmClient|null;gateway:string;settings:ReactNode;status:ReactNode;ledgerPanel:ReactNode;mirror?:ReactNode;renderCarePlan?:(student:string)=>ReactNode}){
  const [tab,setTab]=useState<Tab>('今天'),[consults,setConsults]=useState<StoredConsult[]>([]),[adherence,setAdherence]=useState<StudentAdherence[]>([]),[loadError,setLoadError]=useState('')
  useEffect(()=>{let active=true;const refresh=()=>{void Promise.all([listConsults(store),listStudentAdherence(store)]).then(([rows,reports])=>{if(active){setConsults(prioritizeConsults(rows));setAdherence(reports);setLoadError('')}}).catch(()=>{if(active)setLoadError('待处理问诊读取失败，请稍后重试。')})};refresh();window.addEventListener('aster:data-changed',refresh);return()=>{active=false;window.removeEventListener('aster:data-changed',refresh)}},[store,tab])
  // M1-23a：今天页把本周坚持率低于一半的学生排在前面；null（本周没作业）不参与排序、不显示 0%。
  const today=localDay(new Date()),ranked=rankStudentAdherence(adherence,today)
  return <div className="teacher-shell"><header className="teacher-top"><strong>知衡 · 老师</strong>{status}</header>
    <div className="teacher-content">
      {tab==='今天'&&<main><h1>今天</h1><p className="teacher-count">{consults.length} <span>份待处理问诊</span></p>{loadError&&<p role="alert">{loadError}</p>}
        {consults.length===0?<section className="teacher-card"><h2>现在没有待处理问诊</h2><p>有学生留言时，会出现在这里。</p></section>:consults.map(c=><article className={'teacher-card'+(urgentConsult(c)?' urgent':'')} key={c.encounter.id}>{urgentConsult(c)&&<strong>急症提醒 · 请优先查看</strong>}<h2>{c.encounter.intake.chiefComplaint.value??'问诊留言'}</h2><button onClick={()=>setTab('远程')}>去处理问诊</button></article>)}
        <section className="teacher-card"><h2>学生本周坚持</h2>
          {ranked.length===0&&<p>还没有学生发来本周练习小结；学生在本机打卡后会自动同步数值。</p>}
          {ranked.map(report=><p key={report.student} className={report.weeklyRate!==null&&report.weeklyRate<0.5?'teacher-count':'inbox-note'}>
            {report.forMember??report.student.slice(0,8)+'…'} · 本周练习 {report.practiceDays} 天
            {report.weeklyRate===null?' · 本周没有安排作业':` · 坚持率 ${Math.round(report.weeklyRate*100)}%`}
            {report.streak>0?` · 已连续 ${report.streak} 天`:''}
          </p>)}
          {ranked.some(report=>report.weeklyRate!==null&&report.weeklyRate<0.5)&&<p className="inbox-note">坚持率低于一半的排在上面；只提醒，不替学生做判断。</p>}
        </section>
        <section className="teacher-card"><h2>我的镜子</h2>{mirror??<DailyMirrorCard store={store} llm={llm} teacher={identity.publicKey}/>}<details><summary>给自己定制调养方案</summary><TeacherCarePlan identity={identity} store={store} student={identity.publicKey} llm={llm}/></details></section>
      </main>}
      {tab==='面诊'&&<InPersonPage identity={identity} store={store} llm={llm} send={stack?.send} onBack={()=>setTab('今天')}/>}
      {tab==='远程'&&(stack?<TeacherInboxPage renderCarePlan={renderCarePlan??(student=><TeacherCarePlan key={student} identity={identity} store={store} student={student} llm={llm} send={stack.send}/>)} identity={identity} store={store} llm={llm} send={stack.send} ledger={stack.ledger} onBack={()=>setTab('今天')}/>:<main><h1>远程工作台</h1><p>暂未连接社区，请在管理页检查设置。</p></main>)}
      {tab==='管理'&&<main><h1>管理</h1><section className="teacher-card">{ledgerPanel}</section><section className="teacher-card"><h2>邀请学生</h2><InviteSettings identity={identity} gateway={gateway}/></section><section className="teacher-card"><TemplateSettings store={store}/></section></main>}
      <section hidden={tab!=='管理'} className="teacher-settings">{settings}</section>
    </div>
    <nav className="teacher-nav" aria-label="老师页面">{(['今天','面诊','远程','管理'] as Tab[]).map(name=><button key={name} aria-current={tab===name?'page':undefined} onClick={()=>setTab(name)}>{name}</button>)}</nav>
  </div>
}
