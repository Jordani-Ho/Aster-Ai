import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
export class MemberStore {
 constructor(file,beforeRename=()=>{}){this.file=file;this.beforeRename=beforeRename;this.legacyTeachers=new Set();this.state()}
 recognizeLegacyTeacher(key){this.checkKey(key);if(this.has(key))this.legacyTeachers.add(key)}
 state(){
  const value=JSON.parse(readFileSync(this.file,'utf8'))
  const state=Array.isArray(value)?{members:value,teachers:[],coreMembers:[]} : value
  const valid=keys=>Array.isArray(keys)&&keys.every(key=>typeof key==='string'&&/^[0-9a-f]{64}$/.test(key))
  if(!state||!valid(state.members)||!valid(state.teachers)||!valid(state.coreMembers)||state.teachers.some(key=>!state.members.includes(key))||state.coreMembers.some(key=>!state.members.includes(key)))throw Error('invalid members file')
  const members=[...new Set(state.members)]
  return {members,teachers:[...new Set([...state.teachers,...[...this.legacyTeachers].filter(key=>members.includes(key))])],coreMembers:[...new Set(state.coreMembers)]}
 }
 all(){return new Set(this.state().members)}
 has(key){return this.all().has(key)}
 hasCoreMembers(){return this.state().coreMembers.length>0}
 isTeacher(key){return this.state().teachers.includes(key)}
 isCoreMember(key){return this.state().coreMembers.includes(key)}
 add(key){this.checkKey(key);return this.update(state=>{if(!state.members.includes(key))state.members.push(key)})}
 addTeacher(key){this.checkKey(key);return this.update(state=>{if(!state.members.includes(key))state.members.push(key);if(!state.teachers.includes(key))state.teachers.push(key)})}
 addCoreMember(key){this.checkKey(key);return this.update(state=>{if(!state.members.includes(key))state.members.push(key);if(!state.coreMembers.includes(key))state.coreMembers.push(key)})}
 checkKey(key){if(typeof key!=='string'||!/^[0-9a-f]{64}$/.test(key))throw Error('invalid member')}
 update(edit){const state=this.state();edit(state);this.write(state)}
 write(value){
  const temp=this.file+'.'+randomUUID()+'.tmp'
  try{writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});const fd=openSync(temp,'r+');try{fsyncSync(fd)}finally{closeSync(fd)};this.beforeRename();renameSync(temp,this.file)}catch(error){try{unlinkSync(temp)}catch{}throw error}
 }
}

export function atomicJson(file,value){const temp=file+'.'+randomUUID()+'.tmp';try{writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});const fd=openSync(temp,'r+');try{fsyncSync(fd)}finally{closeSync(fd)};renameSync(temp,file)}catch(error){try{unlinkSync(temp)}catch{}throw error}}
