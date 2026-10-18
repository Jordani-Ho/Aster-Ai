import type { LocalStore } from '../store'
import { validateObservation, type HealthObservation } from '../../../../domain/tcm/kangbi'
export type KangbiEvent = {id:string;at:string;type:'create'|'flow'|'decline';amount:number;from:string|null;to:string|null}
export interface KangbiExternalConnection {publish(summary:KangbiSummary):Promise<void>}
export interface KangbiSummary {participants:number;observations:number;practiceDays:number;teacherMinutes:number;consultations:number;ratings:{teacher:{count:number;sum:number};self:{count:number;sum:number};measurement:{count:number;sum:number}}}
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
export async function kangbiSummary(store:LocalStore):Promise<KangbiSummary> {
 const rows=await store.list('kangbi-observations'),people=new Set<string>()
 const result:KangbiSummary={participants:0,observations:0,practiceDays:0,teacherMinutes:0,consultations:0,ratings:{teacher:{count:0,sum:0},self:{count:0,sum:0},measurement:{count:0,sum:0}}}
 for(const row of rows){const value=row.value as unknown as HealthObservation;validateObservation(value);people.add(value.student);people.add(value.teacher);result.observations++;result.practiceDays+=value.practiceDays;result.teacherMinutes+=value.teacherMinutes;result.consultations+=value.consultations;for(const key of ['teacher','self','measurement'] as const){const score=value.effects[key];if(score!==null){result.ratings[key].count++;result.ratings[key].sum+=score}}}
 result.participants=people.size
 return result
}
