import React from 'react'
import {createRoot} from 'react-dom/client'
import {VisitPage} from '../app/src/VisitPage'
import {TeacherStudentsPage} from '../app/src/TeacherStudentsPage'
import {createIdentity} from '../app/src/core/identity'
import {openStore} from '../app/src/core/store'
import {rememberTeacherStudent} from '../app/src/core/records/teacher'
import {addTeacher,createInbox} from '../app/src/core/inbox'
import {saveInPersonDraft,startInPersonEncounter} from '../app/src/core/record/in-person'
const params=new URLSearchParams(location.search)
const identity=createIdentity(),studentIdentity=createIdentity(),student=studentIdentity.publicKey,store=await openStore(identity,{name:'synthetic-visit-'+crypto.randomUUID()})
const studentStore=await openStore(studentIdentity,{name:'synthetic-visit-student-'+crypto.randomUUID()})
await addTeacher(studentStore,identity.publicKey)
const inbox=createInbox({identity:studentIdentity,store:studentStore})
await rememberTeacherStudent(store,student)
await store.put('teacher-student-basics',student,{alias:'合成学生',gender:'other',age:30,bazi:null,city:'北京市',at:1})
if(params.has('roster') || params.has('students')) for(const key of ['a'.repeat(64),'b'.repeat(64)]) await rememberTeacherStudent(store,key)
if(params.has('resume')) await saveInPersonDraft(store,startInPersonEncounter({teacher:identity.publicKey,student}))
const empty={text:null,citations:[]},organized={chiefComplaint:{text:'合成主诉',citations:[1]},presentIllness:{text:'合成现病史',citations:[1]},look:{text:'合成望',citations:[1]},listenSmell:{text:'合成闻',citations:[1]},ask:{text:'合成问',citations:[1]},pulse:{text:'合成切',citations:[1]}}
const llm={complete:async()=>JSON.stringify({organized}),stream:async()=>''}
Object.assign(window,{__visit:{store,identity,student,studentStore,empty}})
createRoot(document.getElementById('root')!).render(params.has('students') ? <TeacherStudentsPage identity={identity} store={store} llm={null} onVisit={()=>{}} /> : <VisitPage identity={identity} store={store} llm={params.has('no-model') ? null : llm} send={async (_to,envelope)=>{await inbox.receive({id:crypto.randomUUID(),at:1,sender:identity.publicKey,envelope})}} initialStudent={params.has('roster') || params.has('resume') ? undefined : student} onExit={()=>{}} />)
