import {describe,it,expect} from 'vitest'
import {openStore} from '../store'
import {createIdentity} from '../identity'
import {loadTeacherTemplate,saveTeacherTemplate} from './template'
import {indexedDB} from 'fake-indexeddb'
import initial from '../../../../domain/tcm/templates/default.json'
describe('管理页本机模板',()=>{it('真实加密存储往返，下次起草可读取；非法模板不覆盖',async()=>{
 const identity=createIdentity()
 const store=await openStore(identity,{factory:indexedDB,name:'m120-template-'+crypto.randomUUID()})
 try{expect(await loadTeacherTemplate(store)).toEqual(initial);const saved={...initial,name:'合成模板',notes:'合成老师要点',focus:['九问旧病']};await saveTeacherTemplate(store,saved);expect(await loadTeacherTemplate(store)).toEqual(saved);await expect(saveTeacherTemplate(store,{...saved,focus:[]})).rejects.toThrow();expect(await loadTeacherTemplate(store)).toEqual(saved)}finally{store.close();identity.privateKey.fill(0)}
})})
