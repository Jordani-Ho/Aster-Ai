import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StudentToday } from '../app/src/StudentToday'
import { ConsultPage } from '../app/src/ConsultPage'
import { openStore, resumeStore } from '../app/src/core/store'
import { createIdentity } from '../app/src/core/identity'
import { savePersonalModel } from '../app/src/core/llm/personal'
import { addTeacher, consultEnvelope, createInbox } from '../app/src/core/inbox'
import { loadProfile, saveProfile, startSession, saveDraft, loadDraft, markReviewed } from '../app/src/core/intake/session'
import template from '../domain/tcm/templates/default.json'
import type { TeacherTemplate } from '../domain/tcm/templates/types'
import type { ConsultPackage } from '../app/src/core/record/types'
async function node(name:string) {const prior=await resumeStore({name});if(prior)return prior;const identity=createIdentity();return {identity,store:await openStore(identity,{name})}}
const {identity,store}=await node('abstractor-browser'),{identity:teacher,store:target}=await node('abstractor-teacher')
const scoped=store.scoped('f1-')
await savePersonalModel(store,{provider:'qwen',baseUrl:'https://synthetic.invalid/v1',model:'qwen3-vl-plus',apiKey:'SYNTHETIC',testedAt:new Date().toISOString()})
for(const current of [store,scoped]) {
 const profile=await loadProfile(current);profile.city={value:'北京市',source:'student'};await saveProfile(current,profile)
 await addTeacher(current,teacher.publicKey)
 if(!await loadDraft(current))await saveDraft(current,markReviewed({...startSession({student:identity.publicKey,teacher:teacher.publicKey,template:template as TeacherTemplate}),phase:'confirm'}))
}
const inbox=createInbox({identity:teacher,store:target})
const sent:unknown[]=[]
async function send(pkg:ConsultPackage) {const envelope=consultEnvelope(pkg);sent.push(envelope);await inbox.receive({id:crypto.randomUUID(),sender:identity.publicKey,at:Math.floor(Date.now()/1000),envelope})}
Object.assign(window,{inspectAbstractor:async()=>{
 const dumps=[]
 for(const db of await indexedDB.databases()) {
  const opened=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(db.name!);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
  const tx=opened.transaction('records'), rows=await new Promise<unknown[]>((resolve,reject)=>{const r=tx.objectStore('records').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
  dumps.push(rows);opened.close()
 }
 return {dumps,sent,root:await store.list('tongue-records'),tongueCrops:await store.list('tongue-crops'),tongueFailures:await store.list('tongue-failures'),family:await scoped.list('tongue-records'),teacher:await target.list('consult-package'),familyDraft:await loadDraft(scoped)}
}})
function Harness(){const [tab,setTab]=useState('today'),[family,setFamily]=useState(false);const current=family?scoped:store;return <><button onClick={()=>setTab(value=>value==='today'?'consult':'today')}>切换页面</button><button aria-pressed={family} onClick={()=>setFamily(value=>!value)}>切换家人</button>{tab==='today'?<StudentToday key={String(family)} store={current} modelStore={store} settingsStore={store} identity={identity} llm={null} teacher={teacher.publicKey} teacherCall="阿慈老师" teacherName="合成养生馆" onConsult={()=>setTab('consult')} onHomework={()=>{}} onCheckedIn={()=>{}} />:<ConsultPage key={String(family)} store={current} modelStore={store} identity={identity} llm={null} sendConsult={send}/>}</>}
createRoot(document.getElementById('root')!).render(<Harness/> )
