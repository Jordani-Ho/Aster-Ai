import {useEffect,useState} from 'react'
import {loadTeachers,removeTeacher} from './core/inbox'
import type {LocalStore} from './core/store'
export function TeacherListSettings({store}:{store:LocalStore}){
 const [teachers,setTeachers]=useState<string[]>([]),[error,setError]=useState('')
 useEffect(()=>{void loadTeachers(store).then(setTeachers).catch(()=>setError('老师名单暂时无法读取。'))},[store])
 return <section aria-label="我的老师"><h3>我的老师</h3><p>打开老师的邀请链接即可加入，病历只接收已登记老师的签字版本。</p>{!teachers.length&&<p>请向老师要一个邀请链接。</p>}<ul>{teachers.map((teacher,i)=><li key={teacher}>老师{i+1} <button onClick={()=>void removeTeacher(store,teacher).then(setTeachers).catch(()=>setError('暂时未能移除。'))}>移除</button></li>)}</ul>{error&&<p role="alert">{error}</p>}</section>
}
