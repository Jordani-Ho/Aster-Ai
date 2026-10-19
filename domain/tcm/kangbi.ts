import type { ObservationNote } from './observation'

// V2-10：康币观察记录。只存计数、两句话与老师占用时间，不含病历内容或照片。
// 本人感受不在这里（医纲：本人感受不进康币）：它只存在学生本机自己的集合里。
export interface KangbiRules {
 weights:{teacher:number|null;measurement:number|null}
 kePerPracticeDay:number|null;declinePerUnit:number|null;kePerConsultation:number|null;minutesPerKe:number|null;dailyCap:number|null
}
export interface HealthObservation {
 id:string;student:string;teacher:string;at:string
 /** 观察周期：从上次签字到这次签字；第一次从学生加入那天算起。 */
 periodStart:string;periodEnd:string
 practiceDays:number;teacherMinutes:number;consultations:number
 /** 老师签字时选的那一句；null = 未评价。 */
 teacherNote:ObservationNote
 /** 学生智能体在发送问诊时算出的那一句；null = 没有数据或未评价。 */
 agentNote:ObservationNote
 /** 客观量表（诊断/测量），生产值仍为 null；没有 self。 */
 effects:{teacher:number|null;measurement:number|null}
}
const CHOICE = new Set(['improve','same','worse','unsure'])
function choiceOrNull(value:unknown): boolean {return value===null||(typeof value==='string'&&CHOICE.has(value))}
function iso(value:unknown): boolean {return typeof value==='string'&&Number.isFinite(Date.parse(value))}
function count(value:unknown): boolean {return Number.isInteger(value)&&(value as number)>=0}
// 新记录只接受这一套字段（V2-10）：周期起止、有效坚持天数、老师分钟、老师一句、智能体一句、客观量表。
export function validateObservation(value:HealthObservation):void {
 if(!value||!/^[A-Za-z0-9_-]{1,64}$/.test(value.id)||!iso(value.at)||![value.student,value.teacher].every(v=>/^[a-f0-9]{64}$/.test(v)))throw Error('观察记录无效')
 if(!iso(value.periodStart)||!iso(value.periodEnd)||Date.parse(value.periodStart)>Date.parse(value.periodEnd))throw Error('观察周期无效')
 for(const n of [value.practiceDays,value.consultations])if(!count(n))throw Error('观察天数或次数无效')
 // 老师分钟是设备计时，允许小数；不能当整数截断。
 if(!Number.isFinite(value.teacherMinutes)||value.teacherMinutes<0)throw Error('观察时长无效')
 if(!choiceOrNull(value.teacherNote)||!choiceOrNull(value.agentNote))throw Error('观察评语无效，未评价留空')
 if(!value.effects||Object.keys(value.effects).sort().join(',')!=='measurement,teacher')throw Error('客观量表无效')
 for(const n of Object.values(value.effects))if(n!==null&&!Number.isFinite(n))throw Error('客观量表无效，未评价留空')
 if(Object.keys(value).sort().join(',')!=='agentNote,at,consultations,effects,id,periodEnd,periodStart,practiceDays,student,teacher,teacherMinutes,teacherNote')throw Error('观察记录含额外字段')
}
// V2-04 的旧记录（没有周期与两句话，errors 里有 self）仍然能读：这里只做读时归一，不改写盘上的数据。
export function normalizeObservation(value:unknown):HealthObservation|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 try{validateObservation(value as HealthObservation);return JSON.parse(JSON.stringify(value)) as HealthObservation}catch{/* 试旧格式 */}
 const v=value as Record<string,unknown>
 if(!iso(v.at)||typeof v.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(v.id))return null
 if(typeof v.student!=='string'||typeof v.teacher!=='string'||![v.student,v.teacher].every(k=>/^[a-f0-9]{64}$/.test(k)))return null
 for(const n of [v.practiceDays,v.consultations])if(!count(n))return null
 if(!Number.isFinite(v.teacherMinutes)||(v.teacherMinutes as number)<0)return null
 const effects=v.effects as Record<string,unknown>|undefined
 if(!effects||typeof effects!=='object'||Array.isArray(effects))return null
 if(Object.keys(effects).sort().join(',')!=='measurement,self,teacher')return null
 for(const n of Object.values(effects))if(n!==null&&!Number.isFinite(n))return null
 return {
  id:v.id as string,student:v.student as string,teacher:v.teacher as string,at:v.at as string,
  periodStart:v.at as string,periodEnd:v.at as string,
  practiceDays:v.practiceDays as number,teacherMinutes:v.teacherMinutes as number,consultations:v.consultations as number,
  teacherNote:null,agentNote:null,
  effects:{teacher:effects.teacher as number|null,measurement:effects.measurement as number|null},
 }
}
// 生产配置为 null 时返回未启用，绝不把 null 当零或自行补默认比例。
export function calculateKangbi(observation:HealthObservation,rules:KangbiRules,createdToday=0):{create:number;flow:number;decline:number}|null {
 validateObservation(observation)
 const all=[...Object.values(rules.weights),rules.kePerPracticeDay,rules.declinePerUnit,rules.kePerConsultation,rules.minutesPerKe,rules.dailyCap]
 if(all.some(v=>v===null))return null
 if(all.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0)||!rules.minutesPerKe||Math.abs(Object.values(rules.weights).reduce<number>((sum,v)=>sum+v!,0)-1)>Number.EPSILON*8||!Number.isFinite(createdToday)||createdToday<0)throw Error('康币规则无效')
 if(Object.values(observation.effects).some(v=>v===null))return null
 const effect=(Object.keys(rules.weights) as (keyof KangbiRules['weights'])[]).reduce((sum,key)=>sum+observation.effects[key]!*rules.weights[key]!,0)
 const result={create:Math.min(Math.max(0,rules.dailyCap!-createdToday),observation.practiceDays*rules.kePerPracticeDay!*Math.max(0,effect)),flow:observation.teacherMinutes>0?observation.teacherMinutes/rules.minutesPerKe!:observation.consultations*rules.kePerConsultation!,decline:Math.max(0,-effect)*rules.declinePerUnit!}
 if(Object.values(result).some(v=>!Number.isFinite(v)))throw Error('康币计算超出范围')
 return result
}
