import initial from '../../../../domain/tcm/templates/default.json'
import type {TeacherTemplate} from '../../../../domain/tcm/templates/types'
import type {LocalStore} from '../store'
function validate(value:TeacherTemplate):TeacherTemplate {
  if(!value||typeof value.name!=='string'||!value.name.trim()||value.name.length>100||typeof value.notes!=='string'||value.notes.length>4000||!Array.isArray(value.focus)||value.focus.length===0||value.focus.length>30||value.focus.some(t=>typeof t!=='string'||!t.trim()||t.length>100)||!Array.isArray(value.recordOrder)||!value.recordOrder.length)throw Error('模板无效')
  return {id:initial.id,name:value.name.trim(),notes:value.notes,focus:value.focus.map(t=>t.trim()),recordOrder:[...initial.recordOrder]}
}
export async function loadTeacherTemplate(store:LocalStore):Promise<TeacherTemplate>{const v=await store.get('settings','teacher-template');return v?validate(v as unknown as TeacherTemplate):structuredClone(initial)}
export async function saveTeacherTemplate(store:LocalStore,value:TeacherTemplate):Promise<void>{await store.put('settings','teacher-template',{...validate(value)})}
