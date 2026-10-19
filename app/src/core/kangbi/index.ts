import type { LocalStore, StoreValue } from '../store'
import { parseTongueAbstract, type TongueAbstract } from '../../../../domain/tcm/tongue'
import { dailyAdherence } from '../adherence'
import { listCheckins, type Assignment } from '../homework'
import { localDay } from '../homework/schedule'
import { listTeacherRecords } from '../records/teacher'
import { listIdentityLinks, oldKeysFor } from '../identity/links'
import {
  calculateKangbi, normalizeObservation, validateObservation,
  type HealthObservation, type KangbiRules,
} from '../../../../domain/tcm/kangbi'
import {
  OBSERVATION_CHOICES, OBSERVATION_LABELS, observationNoteText, parsePeriodObservation, validObservationChoice,
  type ObservationChoice, type ObservationNote, type PeriodObservation,
} from '../../../../domain/tcm/observation'
import { agentObservation, OBSERVATION_RULES, type ObservationRules } from '../../../../domain/tcm/observation-rules'

export type * from '../../../../domain/tcm/kangbi'
export { OBSERVATION_CHOICES, OBSERVATION_LABELS, observationNoteText, parsePeriodObservation, validObservationChoice }
export type { ObservationChoice, ObservationNote, PeriodObservation }

export type KangbiEvent = {id:string;at:string;type:'create'|'flow'|'decline';amount:number;from:string|null;to:string|null}
export interface KangbiExternalConnection {publish(summary:KangbiSummary):Promise<void>}
export interface KangbiSummary {participants:number;observations:number;practiceDays:number;teacherMinutes:number;consultations:number;ratings:{teacher:{count:number;sum:number};measurement:{count:number;sum:number}}}

const HEX64 = /^[0-9a-f]{64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
/** 学生本人的“这段时间自己感觉”：只存在本机，不随任何信封发出，不进老师端观察记录。 */
export const SELF_OBSERVATIONS = 'kangbi-self'
export const TONGUE_COLLECTION = 'tongue-records'

export interface SelfObservation {id:string;student:string;teacher:string;at:string;choice:ObservationChoice}

export async function observationId(parts:readonly string[]):Promise<string> {
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parts)))
 return Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('')
}
export async function recordObservation(store:LocalStore,value:HealthObservation):Promise<void> {
 validateObservation(value)
 const previous=await store.get('kangbi-observations',value.id)
 if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw Error('观察编号已使用，请保留原记录')
 await store.put('kangbi-observations',value.id,structuredClone(value) as never)
 // 仅保留观察数据；生产规则尚未定值，没有自动记账或余额入口。
}
// 旧的 V2-04 记录（含 self 评分）读时归一，不重写本机数据；汇总不再出本人感受。
export async function kangbiSummary(store:LocalStore):Promise<KangbiSummary> {
 const rows=await store.list('kangbi-observations'),people=new Set<string>()
 const result:KangbiSummary={participants:0,observations:0,practiceDays:0,teacherMinutes:0,consultations:0,ratings:{teacher:{count:0,sum:0},measurement:{count:0,sum:0}}}
 for(const row of rows){const value=normalizeObservation(row.value);if(!value)continue;people.add(value.student);people.add(value.teacher);result.observations++;result.practiceDays+=value.practiceDays;result.teacherMinutes+=value.teacherMinutes;result.consultations+=value.consultations;for(const key of ['teacher','measurement'] as const){const score=value.effects[key];if(score!==null){result.ratings[key].count++;result.ratings[key].sum+=score}}}
 result.participants=people.size
 return result
}
export async function listObservations(store:Pick<LocalStore,'list'>):Promise<HealthObservation[]> {
 const result:HealthObservation[]=[]
 for(const row of await store.list('kangbi-observations')){const value=normalizeObservation(row.value);if(value)result.push(value)}
 return result.sort((left,right)=>Date.parse(left.at)-Date.parse(right.at))
}

// ---- V2-10 老师签字后写一条观察记录 ----

export async function recordSignedObservation(store:LocalStore,options:{
 id:string;student:string;teacher:string;at:Date;teacherMinutes:number;consultations:number;
 teacherNote:ObservationNote;report:PeriodObservation|null|undefined
}):Promise<HealthObservation> {
 const at=options.at.toISOString()
 const window=await teacherObservationWindow(store,{student:options.student,now:options.at,excludeEventId:options.id})
 const value:HealthObservation={
  id:options.id,student:options.student,teacher:options.teacher,at,
  periodStart:window.start,periodEnd:window.end,
  practiceDays:options.report?.practiceDays??0,
  teacherMinutes:Math.max(0,options.teacherMinutes),
  consultations:options.consultations,
  teacherNote:options.teacherNote??null,
  agentNote:options.report?.agentNote??null,
  effects:{teacher:null,measurement:null},
 }
 await recordObservation(store,value)
 return value
}

// ---- V2-10 观察周期 ----

export interface ObservationWindow {start:string;end:string}

/** 周期起点 = 上次签字；没有上次签字时用学生加入那天；都没有就从现在起（零长度周期）。 */
export function observationWindow(options:{previousSignedAt?:string|null;joinedAt?:string|null;now?:Date}):ObservationWindow {
 const now=options.now??new Date()
 const end=now.toISOString()
 const usable=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now.getTime()
 const start=usable(options.previousSignedAt)?options.previousSignedAt:usable(options.joinedAt)?options.joinedAt:end
 return {start,end}
}

/** 老师端：上次给这位学生签字的时间；换机关系里的旧学生公钥也算同一个人。 */
export async function teacherObservationWindow(store:LocalStore,options:{student:string;now?:Date;excludeEventId?:string}):Promise<ObservationWindow> {
 const links=await listIdentityLinks(store)
 const students=new Set([options.student,...oldKeysFor(links,'student',options.student)])
 const records=(await listTeacherRecords(store)).filter(record=>record.eventId!==options.excludeEventId&&students.has(record.student))
 const now=options.now??new Date()
 return observationWindow({previousSignedAt:records[0]?.createdAt??null,joinedAt:await teacherJoinedAt(store,students),now})
}

async function teacherJoinedAt(store:Pick<LocalStore,'list'>,students:ReadonlySet<string>):Promise<string|null> {
 let earliest:string|null=null
 for(const row of await store.list('consult-package')){
  const value=row.value as {sender?:unknown;receivedAt?:unknown;encounter?:{student?:unknown}}|undefined
  const student=typeof value?.encounter?.student==='string'?value.encounter.student:typeof value?.sender==='string'?value.sender:null
  if(!student||!students.has(student))continue
  const receivedAt=typeof value?.receivedAt==='string'&&Number.isFinite(Date.parse(value.receivedAt))?value.receivedAt:null
  if(receivedAt&&(earliest===null||receivedAt<earliest))earliest=receivedAt
 }
 return earliest
}

/** 学生端：上次收到这位老师签字病历的时间；没有就用加入时间（新加入的学生在邀请流程里记）。 */
export async function studentObservationWindow(store:LocalStore,options:{teacher:string;now?:Date}):Promise<ObservationWindow> {
 const now=options.now??new Date()
 const links=await listIdentityLinks(store)
 const teachers=new Set([options.teacher,...oldKeysFor(links,'teacher',options.teacher)])
 let previousSignedAt:string|null=null
 for(const row of await store.list('student-records')){
  const value=row.value as {teacher?:unknown;createdAt?:unknown}|undefined
  if(typeof value?.teacher!=='string'||!teachers.has(value.teacher))continue
  if(typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||Date.parse(value.createdAt)>now.getTime())continue
  if(previousSignedAt===null||value.createdAt>previousSignedAt)previousSignedAt=value.createdAt
 }
 const joinedAtValue=await store.get('settings','joined-at')
 const joinedAt=typeof joinedAtValue==='string'&&Number.isFinite(Date.parse(joinedAtValue))?joinedAtValue:null
 return observationWindow({previousSignedAt,joinedAt,now})
}

/** 学生智能体的那一句：坚持率取自这段时间的作业排程与打卡，舌象取周期内最近一张与周期前最近一张。 */
export async function agentObservationFor(store:LocalStore,options:{teacher:string;now?:Date;rules?:ObservationRules}):Promise<{choice:ObservationChoice;window:ObservationWindow;practiceDays:number;adherenceRate:number|null}> {
 const window=await studentObservationWindow(store,{teacher:options.teacher,...(options.now?{now:options.now}:{})})
 const from=localDay(new Date(window.start)),to=localDay(new Date(window.end))
 const assignments=(await store.list('homework')).map(row=>row.value as unknown as Assignment)
 const checkins=await listCheckins(store)
 const days=dailyAdherence(assignments,checkins,from,to)
 const practiceDays=days.filter(day=>day.done>0).length
 const scheduled=days.reduce((sum,day)=>sum+day.scheduled,0)
 const done=days.reduce((sum,day)=>sum+day.done,0)
 const adherenceRate=scheduled===0?null:done/scheduled
 const tongues=await tongueRecords(store)
 let current:{day:string;record:TongueAbstract}|null=null,previous:{day:string;record:TongueAbstract}|null=null
 for(const [day,record] of tongues){
  if(day<=to&&(current===null||day>current.day))current={day,record}
  if(day<from&&(previous===null||day>previous.day))previous={day,record}
 }
 const choice=agentObservation({
  practiceDays,
  adherenceRate,
  currentTongue:current?.record.features??null,
  previousTongue:previous?.record.features??null,
 },options.rules??OBSERVATION_RULES)
 return {choice,window,practiceDays,adherenceRate}
}

async function tongueRecords(store:Pick<LocalStore,'list'>):Promise<[string,TongueAbstract][]> {
 const result:[string,TongueAbstract][]=[]
 for(const row of await store.list(TONGUE_COLLECTION)){
  if(!DAY.test(row.key))continue
  try{result.push([row.key,parseTongueAbstract(row.value)])}catch{/* 坏记录跳过 */}
 }
 return result.sort((left,right)=>left[0].localeCompare(right[0]))
}

/** 学生把这一段时间的计数与智能体那句随问诊包发给老师；本人感受不在这里。 */
export async function buildPeriodObservation(store:LocalStore,options:{teacher:string;now?:Date;rules?:ObservationRules}):Promise<PeriodObservation> {
 const result=await agentObservationFor(store,options)
 return {
  periodStart:result.window.start,
  periodEnd:result.window.end,
  practiceDays:result.practiceDays,
  adherenceRate:result.adherenceRate,
  agentNote:result.choice,
 }
}

// ---- V2-10 学生本人的那一句（只在本机） ----

export async function recordSelfObservation(store:LocalStore,options:{student:string;teacher:string;choice:ObservationChoice;now?:Date}):Promise<SelfObservation> {
 if(!HEX64.test(options.student)||!HEX64.test(options.teacher))throw Error('本人感受的公钥无效')
 if(!validObservationChoice(options.choice))throw Error('本人感受只能是四选一')
 const at=(options.now??new Date()).toISOString()
 const id=await observationId(['self',options.student,options.teacher,localDay(new Date(at))])
 const value:SelfObservation={id,student:options.student,teacher:options.teacher,at,choice:options.choice}
 await store.put(SELF_OBSERVATIONS,id,value as unknown as StoreValue)
 return value
}

export async function listSelfObservations(store:Pick<LocalStore,'list'>,options:{student?:string;teacher?:string}={}):Promise<SelfObservation[]> {
 const result:SelfObservation[]=[]
 for(const row of await store.list(SELF_OBSERVATIONS)){
  const value=row.value as Partial<SelfObservation>|undefined
  if(!value||typeof value!=='object'||value.id!==row.key)continue
  if(typeof value.student!=='string'||!HEX64.test(value.student)||typeof value.teacher!=='string'||!HEX64.test(value.teacher))continue
  if(typeof value.at!=='string'||!Number.isFinite(Date.parse(value.at))||!validObservationChoice(value.choice))continue
  if(options.student&&value.student!==options.student)continue
  if(options.teacher&&value.teacher!==options.teacher)continue
  result.push({id:value.id,student:value.student,teacher:value.teacher,at:value.at,choice:value.choice})
 }
 return result.sort((left,right)=>left.at.localeCompare(right.at))
}

/** 当前周期里最近一条本人感受；没有就是未评价（null），不拿持平代替。 */
export async function latestSelfObservation(store:Pick<LocalStore,'list'>,options:{student:string;teacher:string;window:ObservationWindow}):Promise<SelfObservation|null> {
 const rows=await listSelfObservations(store,{student:options.student,teacher:options.teacher})
 const start=Date.parse(options.window.start),end=Date.parse(options.window.end)
 const inWindow=rows.filter(row=>{const at=Date.parse(row.at);return at>=start&&at<=end})
 return inWindow.length===0?null:inWindow[inWindow.length-1]
}

// ---- V2-10 影子试算（只读，无界面入口） ----

export interface ShadowRunCandidateRules extends KangbiRules {}
export interface ShadowRunStudent {student:string;create:number;flow:number;decline:number;net:number;observations:number}
export interface ShadowRunBucket {from:number;to:number;count:number}
export interface ShadowRunResult {
 /** 每人多少刻：create 创造、flow 师生流转、decline 减少、net 创造减减少。 */
 perStudent:ShadowRunStudent[]
 totals:{create:number;flow:number;decline:number;net:number}
 /** 每人 net 刻数的分布（区间按 bucketSize 分桶）。 */
 distribution:{min:number;max:number;mean:number;buckets:ShadowRunBucket[]}
 /** 规则不全或客观量表为空、算不出来的观察条数（不能当零）。 */
 skipped:number
}

/**
 * 影子试算：同一批观察在候选规则下“如果启用，每人会有多少刻”。
 * 只读：不接受 store，不写任何记录；生产规则全 null 时全部跳过、总量为 0。
 * 注意：这里按单条观察逐条计算，不累计跨日上限；上限仍逐条应用。
 */
export function shadowRun(observations:readonly HealthObservation[],candidateRules:ShadowRunCandidateRules,options:{bucketSize?:number}={}):ShadowRunResult {
 const bucketSize=options.bucketSize??1
 if(!Number.isFinite(bucketSize)||bucketSize<=0)throw Error('分桶大小无效')
 const per=new Map<string,ShadowRunStudent>()
 let skipped=0
 for(const raw of observations){
  const observation=normalizeObservation(raw)
  if(!observation){skipped++;continue}
  let result:{create:number;flow:number;decline:number}|null=null
  try{result=calculateKangbi(observation,candidateRules,0)}catch{throw Error('候选规则无效')}
  if(!result){skipped++;continue}
  const row=per.get(observation.student)??{student:observation.student,create:0,flow:0,decline:0,net:0,observations:0}
  row.create+=result.create;row.flow+=result.flow;row.decline+=result.decline;row.observations+=1
  per.set(observation.student,row)
 }
 const perStudent=[...per.values()].map(row=>({...row,net:row.create-row.decline})).sort((left,right)=>left.student.localeCompare(right.student))
 const totals=perStudent.reduce((sum,row)=>({create:sum.create+row.create,flow:sum.flow+row.flow,decline:sum.decline+row.decline,net:sum.net+row.net}),{create:0,flow:0,decline:0,net:0})
 const values=perStudent.map(row=>row.net)
 const min=values.length===0?0:Math.min(...values),max=values.length===0?0:Math.max(...values)
 const mean=values.length===0?0:values.reduce((sum,value)=>sum+value,0)/values.length
 const buckets:ShadowRunBucket[]=[]
 if(values.length>0){
  const first=Math.floor(min/bucketSize)*bucketSize
  const last=Math.ceil(max/bucketSize)*bucketSize
  for(let from=first;from<last;from+=bucketSize){
   const to=from+bucketSize
   buckets.push({from,to,count:values.filter(value=>(value===max?value>=from&&value<=to:value>=from&&value<to)).length})
  }
 }
 return {perStudent,totals,distribution:{min,max,mean,buckets},skipped}
}
