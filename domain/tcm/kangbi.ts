export interface KangbiRules {
 weights:{teacher:number|null;self:number|null;measurement:number|null}
 kePerPracticeDay:number|null;declinePerUnit:number|null;kePerConsultation:number|null;minutesPerKe:number|null;dailyCap:number|null
}
export interface HealthObservation {
 id:string;student:string;teacher:string;at:string;practiceDays:number;teacherMinutes:number;consultations:number
 effects:{teacher:number|null;self:number|null;measurement:number|null}
}
export function validateObservation(value:HealthObservation):void {
 if(!value||!/^[A-Za-z0-9_-]{1,64}$/.test(value.id)||!Number.isFinite(Date.parse(value.at))||![value.student,value.teacher].every(v=>/^[a-f0-9]{64}$/.test(v)))throw Error('观察记录无效')
 for(const n of [value.practiceDays,value.teacherMinutes,value.consultations])if(!Number.isFinite(n)||n<0)throw Error('观察时长无效')
 if(!value.effects||Object.keys(value.effects).sort().join(',')!=='measurement,self,teacher')throw Error('三方评价无效')
 for(const n of Object.values(value.effects))if(n!==null&&!Number.isFinite(n))throw Error('三方评价无效，未评价留空')
 if(Object.keys(value).sort().join(',')!=='at,consultations,effects,id,practiceDays,student,teacher,teacherMinutes')throw Error('观察记录含额外字段')
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
