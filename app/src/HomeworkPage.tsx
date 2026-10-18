import { useEffect, useRef, useState } from 'react'
import type { LocalStore } from './core/store'
import type { Homework } from './core/record/types'
import { checkIn, dueReminders, listCheckins, sevenDayProgress, type Assignment, type Checkin } from './core/homework'
import { localDay, checkinDay, schedule } from './core/homework/schedule'
import { shichenAt } from '../../domain/tcm/calendar'

export function HomeworkPage({store,onBack,onCheckedIn}:{store:LocalStore;onBack:()=>void;onCheckedIn?:()=>void}) {
  const shown = useRef(new Set<string>())
  const [notificationsAllowed,setNotificationsAllowed]=useState(typeof Notification !== 'undefined' && Notification.permission==='granted')
  const [assignments,setAssignments]=useState<Assignment[]>([])
  const [checkins,setCheckins]=useState<Checkin[]>([])
  const [now,setNow]=useState(new Date())
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [notes,setNotes]=useState<Record<string,string>>({})
  const [status,setStatus]=useState('')
  useEffect(()=>{
    let cancelled=false
    void Promise.all([store.list('homework'),listCheckins(store)]).then(([rows,records])=>{
      const items=rows.map(({value})=>value as unknown as Assignment)
      for (const item of items) {
        if (!item.homework || typeof item.homework.id!=='string' || typeof item.homework.title!=='string' || typeof item.startsOn!=='string') throw new Error('作业资料损坏')
        schedule([item.homework],item.startsOn,1)
      }
      if(!cancelled){setAssignments(items);setCheckins(records)}
    }).catch(()=>{if(!cancelled)setError('无法读取本地作业，请检查本机数据')})
    const timer=setInterval(()=>setNow(new Date()),15000)
    const update=()=>setNow(new Date())
    window.addEventListener('focus',update)
    return()=>{cancelled=true;clearInterval(timer);window.removeEventListener('focus',update)}
  },[store])
  const due=dueReminders(assignments,checkins,now)
  useEffect(()=>{
    if(!('Notification' in window)||Notification.permission!=='granted'||!due.length)return
    // 每个挂载会话中，每个作业每日只弹一次；不含作业名称或内容。
    for(const item of due){
      const key=localDay(item.at)+':'+item.homeworkId
      if(shown.current.has(key))continue
      try { new Notification('知衡：有作业待打卡');shown.current.add(key) } catch { /* 不支持系统通知时保留页内提醒 */ }
    }
  },[due.map(item=>localDay(item.at)+item.homeworkId).join('|'),notificationsAllowed])
  const demo=async()=>{
    setBusy(true);setError('')
    try{
      const today=localDay(new Date())
      const fixtures:Homework[]=[
        {id:crypto.randomUUID(),title:'每日练习（示例）',detail:'合成示例，请以老师实际布置的作业为准。',source:'teacher',schedule:{kind:'daily',time:'08:00'},durationDays:7},
        {id:crypto.randomUUID(),title:'酉时练习（示例）',detail:'合成时辰排程示例。',source:'teacher',schedule:{kind:'shichen',shichen:'酉'},durationDays:3},
      ]
      const next=fixtures.map(homework=>({homework,startsOn:today}))
      for(const item of next)await store.put('homework',crypto.randomUUID(),JSON.parse(JSON.stringify(item)))
      setAssignments(previous=>[...previous,...next]);setNow(new Date())
    }catch{setError('示例未能保存，请重试')}finally{setBusy(false)}
  }
  const complete=async(id:string)=>{
    setBusy(true);setError('')
    try{const record=await checkIn(store,id,notes[id]);setCheckins(previous=>[...previous,record]);setStatus('已保存在本机');setNow(new Date());onCheckedIn?.()}
    catch{setError('打卡未能保存，请重试')}finally{setBusy(false)}
  }
  return <main className="homework-page">
    <header><button onClick={onBack}>返回</button><p className="eyebrow">知衡 · 学生</p><h1>今日作业</h1><p>{localDay(now)} · {shichenAt(now).name}时</p></header>
    {due.length>0&&<aside role="status" className="due-banner">有 {due.length} 项作业到时间了，方便时记得完成。</aside>}
    <p className="privacy-note">打卡只保存在你的手机上。</p>
    <details><summary>提醒设置</summary><p>应用打开时显示到点提醒；关闭后暂时无法定时提醒。</p><button onClick={()=>{if('Notification' in window)void Notification.requestPermission().then(permission=>{setNotificationsAllowed(permission==='granted');setStatus(permission==='granted'?'已允许通知':'保留页面内提醒');setNow(new Date())});else setStatus('当前浏览器使用页面内提醒')}}>允许系统通知</button></details>
    {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
    {!assignments.length&&<section className="homework-card"><h2>还没有作业</h2><p>老师布置的作业会出现在这里。</p><button disabled={busy} onClick={()=>void demo()}>加载示例作业（仅本机演示）</button></section>}
    {assignments.map(({homework,startsOn})=>{
      const reminders=schedule([homework],startsOn,1,localDay(now))
      const habitAnchorText=homework.schedule.kind==='habit'?homework.schedule.anchor:null
      const habitual=habitAnchorText!==null
      const progress=sevenDayProgress(homework,checkins,startsOn,now)
      const completed=checkins.some(item=>item.homeworkId===homework.id&&checkinDay(new Date(item.at))===localDay(now))
      return <section className="homework-card" key={homework.id}>
        <div className="card-heading"><h2>{homework.title}</h2><span className="time-pill">{habitAnchorText!==null?'随习惯：'+habitAnchorText:reminders.length?reminders[0].at.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false}):'今日无安排'}</span></div>
        <p>{homework.detail}</p>
        {(reminders.length>0||habitual)&&<><label>备注（可选）<textarea rows={2} value={notes[homework.id]??''} onChange={e=>setNotes(previous=>({...previous,[homework.id]:e.target.value}))}/></label><button className="checkin-button" disabled={busy||completed} onClick={()=>void complete(homework.id)}>{completed?'今日已完成 ✓':'已完成'}</button></>}
        {habitual
          ? <p className="privacy-note">随习惯作业：今天做这件事的时候点一下打卡，不按钟点提醒；打卡会计入坚持率。</p>
          : <><div className="progress-heading"><h3>近 7 天</h3><span>{progress.completed}/{progress.expected} 次完成</span></div>
            <ol className="week-progress" aria-label={`${homework.title}近7天完成情况`}>{progress.days.map(day=><li key={day.day}><span>{day.day.slice(5)}</span><span className={day.completed?'day-dot done':'day-dot'} aria-label={day.completed?'已完成':day.scheduled?'未完成':'无安排'}>{day.completed?'✓':day.scheduled?'○':'—'}</span></li>)}</ol></>}
      </section>
    })}
    <footer>只记录完成情况，不根据打卡作健康判断。</footer>
  </main>
}

