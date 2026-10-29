import React from 'react'
import {createRoot} from 'react-dom/client'
import {VisitPage} from '../app/src/VisitPage'
import {createIdentity} from '../app/src/core/identity'
import {openStore} from '../app/src/core/store'
import {rememberTeacherStudent} from '../app/src/core/records/teacher'
const identity=createIdentity(),student='a'.repeat(64),store=await openStore(identity,{name:'synthetic-visit-'+crypto.randomUUID()})
await rememberTeacherStudent(store,student)
await store.put('teacher-student-basics',student,{alias:'合成学生',gender:'other',age:30,bazi:null,city:'北京市',at:1})
const empty={text:null,citations:[]},organized={chiefComplaint:{text:'合成主诉',citations:[1]},presentIllness:{text:'合成现病史',citations:[1]},look:{text:'合成望',citations:[1]},listenSmell:{text:'合成闻',citations:[1]},ask:{text:'合成问',citations:[1]},pulse:{text:'合成切',citations:[1]}}
const llm={complete:async()=>JSON.stringify({organized}),stream:async()=>''}
Object.assign(window,{__visit:{store,identity,student,empty}})
createRoot(document.getElementById('root')!).render(<VisitPage identity={identity} store={store} llm={llm} initialStudent={student} onExit={()=>{}} />)
