import React from 'react'
import { createRoot } from 'react-dom/client'
import { LedgerSettings } from '../app/src/LedgerSettings'
import { createIdentity } from '../app/src/core/identity'
import { openStore, resumeStore } from '../app/src/core/store'
import { createLedgerSync } from '../app/src/core/ledger/sync'
import { createLlmClient } from '../app/src/core/llm'
import { moneySummary } from '../app/src/core/ledger/money'
import '../app/src/student.css'
async function session(name:string){const previous=await resumeStore({name});if(previous)return previous;const identity=createIdentity();return {identity,store:await openStore(identity,{name})}}
const teacher=await session('money-teacher'),student=await session('money-student')
let offline=true
const changed=()=>window.dispatchEvent(new Event('aster:data-changed'))
const teacherSync=createLedgerSync({identity:teacher.identity,store:teacher.store,onChange:changed,send:async(_recipient,envelope)=>{if(offline)throw Error('synthetic offline');await studentSync.receive({id:crypto.randomUUID(),sender:teacher.identity.publicKey,at:Math.floor(Date.now()/1000),envelope});return crypto.randomUUID()}})
const studentSync=createLedgerSync({identity:student.identity,store:student.store,onChange:changed,send:async(_recipient,envelope)=>{if(offline)throw Error('synthetic offline');await teacherSync.receive({id:crypto.randomUUID(),sender:student.identity.publicKey,at:Math.floor(Date.now()/1000),envelope});return crypto.randomUUID()}})
await teacherSync.open(teacher.identity.publicKey,student.identity.publicKey);await studentSync.open(teacher.identity.publicKey,student.identity.publicKey)
const llm=createLlmClient({kind:'api-key',baseUrl:'https://money.synthetic.invalid/v1',model:'synthetic',apiKey:'SYNTHETIC'})
Object.assign(window,{moneyOnline:async()=>{offline=false;await teacherSync.flush();await studentSync.flush()},inspectMoney:async()=>{
 const a=await teacherSync.view(teacher.identity.publicKey,student.identity.publicKey),b=await studentSync.view(teacher.identity.publicKey,student.identity.publicKey)
 return {teacher:a.balance,student:b.balance,count:a.ledger.events.length,pending:a.outbox.length,summary:moneySummary([a.ledger]),ids:[teacher.identity.publicKey,student.identity.publicKey],drafts:await teacher.store.list('money-drafts')}
}})
createRoot(document.getElementById('root')!).render(<><section aria-label="老师钱账"><LedgerSettings identity={teacher.identity} store={teacher.store} managed ledger={teacherSync} llm={llm}/></section><section aria-label="学生钱账"><LedgerSettings identity={student.identity} store={student.store} managed ledger={studentSync}/></section></>)
