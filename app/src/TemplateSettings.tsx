import { useEffect, useState } from 'react'
import template from '../../domain/tcm/templates/default.json'
import type { LocalStore } from './core/store'
import { loadTeacherTemplate,saveTeacherTemplate } from './core/drafting/template'
export function TemplateSettings({store}:{store:LocalStore}){
  const [value,setValue]=useState(template),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{void loadTeacherTemplate(store).then(setValue).catch(()=>setNotice('模板读取失败，暂用默认模板。'))},[store])
  return <details><summary>模板</summary><form onSubmit={e=>{e.preventDefault();setBusy(true);void saveTeacherTemplate(store,value).then(()=>setNotice('模板已保存，下次起草生效。')).catch(()=>setNotice('模板未保存，请填写名称、问诊重点和病历顺序。')).finally(()=>setBusy(false))}}><label>模板名称<input value={value.name} onChange={e=>setValue({...value,name:e.target.value})}/></label><label>问诊重点（每行一项）<textarea rows={4} value={value.focus.join('\n')} onChange={e=>setValue({...value,focus:e.target.value.split('\n')})}/></label><label>老师的习惯与要点<textarea rows={3} value={value.notes} onChange={e=>setValue({...value,notes:e.target.value})}/></label><button disabled={busy}>保存模板</button>{notice&&<p role="status">{notice}</p>}</form></details>
}
