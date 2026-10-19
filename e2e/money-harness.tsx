import React from 'react'
import { createRoot } from 'react-dom/client'
import { LedgerSettings } from '../app/src/LedgerSettings'
import { createIdentity } from '../app/src/core/identity'
import { openStore, resumeStore } from '../app/src/core/store'
import { createLedgerSync } from '../app/src/core/ledger/sync'
import { createLlmClient } from '../app/src/core/llm'
import { moneySummary } from '../app/src/core/ledger/money'
import { saveMoneyCurrency } from '../app/src/core/ledger/money'
import '../app/src/student.css'
async function session(name:string){const previous=await resumeStore({name});if(previous)return previous;const identity=createIdentity();return {identity,store:await openStore(identity,{name})}}
const teacher=await session('money-teacher'),student=await session('money-student')
let offline=true
const changed=()=>window.dispatchEvent(new Event('aster:data-changed'))
const teacherSync=createLedgerSync({identity:teacher.identity,store:teacher.store,onChange:changed,send:async(_recipient,envelope)=>{if(offline)throw Error('synthetic offline');await studentSync.receive({id:crypto.randomUUID(),sender:teacher.identity.publicKey,at:Math.floor(Date.now()/1000),envelope});return crypto.randomUUID()}})
const studentSync=createLedgerSync({identity:student.identity,store:student.store,onChange:changed,send:async(_recipient,envelope)=>{if(offline)throw Error('synthetic offline');await teacherSync.receive({id:crypto.randomUUID(),sender:student.identity.publicKey,at:Math.floor(Date.now()/1000),envelope});return crypto.randomUUID()}})
await teacherSync.open(teacher.identity.publicKey,student.identity.publicKey);await studentSync.open(teacher.identity.publicKey,student.identity.publicKey)
// V2-12 首次记账：老师端还没有任何账本；学生通过邀请开过一本空账本；老师上一次用过 CNY。
const firstTeacher=await session('money-first-teacher'),firstStudent=await session('money-first-student')
await firstTeacher.store.put('teacher-students',firstStudent.identity.publicKey,{student:firstStudent.identity.publicKey})
await saveMoneyCurrency(firstTeacher.store,'CNY')
const firstTeacherSync=createLedgerSync({identity:firstTeacher.identity,store:firstTeacher.store,onChange:changed,send:async(_recipient,envelope)=>{if(offline)throw Error('synthetic offline');await firstStudentSync.receive({id:crypto.randomUUID(),sender:firstTeacher.identity.publicKey,at:Math.floor(Date.now()/1000),envelope});return crypto.randomUUID()}})
const firstStudentSync=createLedgerSync({identity:firstStudent.identity,store:firstStudent.store,onChange:changed,send:async(_recipient,envelope)=>{if(offline)throw Error('synthetic offline');await firstTeacherSync.receive({id:crypto.randomUUID(),sender:firstStudent.identity.publicKey,at:Math.floor(Date.now()/1000),envelope});return crypto.randomUUID()}})
await firstStudentSync.open(firstTeacher.identity.publicKey,firstStudent.identity.publicKey)
const llm=createLlmClient({kind:'api-key',baseUrl:'https://money.synthetic.invalid/v1',model:'synthetic',apiKey:'SYNTHETIC'})
Object.assign(window,{moneyOnline:async()=>{offline=false;await teacherSync.flush();await studentSync.flush();await firstTeacherSync.flush();await firstStudentSync.flush()},inspectMoney:async()=>{
 const a=await teacherSync.view(teacher.identity.publicKey,student.identity.publicKey),b=await studentSync.view(teacher.identity.publicKey,student.identity.publicKey)
 return {teacher:a.balance,student:b.balance,count:a.ledger.events.length,pending:a.outbox.length,summary:moneySummary([a.ledger]),ids:[teacher.identity.publicKey,student.identity.publicKey],drafts:await teacher.store.list('money-drafts')}
},inspectFirst:async()=>{
 const teacherBooks=await firstTeacherSync.books(),studentBooks=await firstStudentSync.books()
 const a=teacherBooks.length?await firstTeacherSync.view(firstTeacher.identity.publicKey,firstStudent.identity.publicKey):null
 const b=studentBooks.length?await firstStudentSync.view(firstTeacher.identity.publicKey,firstStudent.identity.publicKey):null
 return {teacher:a?a.balance:null,student:b?b.balance:null,teacherBooks:teacherBooks.length,studentBooks:studentBooks.length,count:a?a.ledger.events.length:0,studentCount:b?b.ledger.events.length:0,currency:a&&a.ledger.events.length?JSON.parse(a.ledger.events[0].content).currency:null}
}})
createRoot(document.getElementById('root')!).render(<><section aria-label="老师钱账"><LedgerSettings identity={teacher.identity} store={teacher.store} managed ledger={teacherSync} llm={llm}/></section><section aria-label="学生钱账"><LedgerSettings identity={student.identity} store={student.store} managed ledger={studentSync}/></section><section aria-label="老师首次记账"><LedgerSettings identity={firstTeacher.identity} store={firstTeacher.store} managed ledger={firstTeacherSync} llm={llm}/></section></>)
