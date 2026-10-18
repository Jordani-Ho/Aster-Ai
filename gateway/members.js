import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
export class MemberStore {
 constructor(file,beforeRename=()=>{}){this.file=file;this.beforeRename=beforeRename;this.all()}
 all(){const values=JSON.parse(readFileSync(this.file,'utf8'));if(!Array.isArray(values)||values.some(v=>typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v)))throw Error('invalid members file');return new Set(values)}
 has(key){return this.all().has(key)}
 add(key){if(!/^[0-9a-f]{64}$/.test(key))throw Error('invalid member');const next=this.all();if(next.has(key))return;next.add(key);const temp=this.file+'.'+randomUUID()+'.tmp';try{writeFileSync(temp,JSON.stringify([...next]),{mode:0o600,flag:'wx'});const fd=openSync(temp,'r+');try{fsyncSync(fd)}finally{closeSync(fd)};this.beforeRename();renameSync(temp,this.file)}catch(error){try{unlinkSync(temp)}catch{}throw error}}
}

export function atomicJson(file,value){const temp=file+'.'+randomUUID()+'.tmp';try{writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});const fd=openSync(temp,'r+');try{fsyncSync(fd)}finally{closeSync(fd)};renameSync(temp,file)}catch(error){try{unlinkSync(temp)}catch{}throw error}}
