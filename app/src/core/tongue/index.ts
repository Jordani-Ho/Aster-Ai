import type { LocalStore } from '../store'
import { abstractTongue, type AbstractContext, type TransientPhoto } from '../abstractor'
import type { VisionClient } from '../llm/vision'
import { parseTongueAbstract, type TongueAbstract } from '../../../../domain/tcm/tongue'
import { localDay } from '../homework/schedule'
export const TONGUE_COLLECTION = 'tongue-records'
export async function saveTongue(store:LocalStore,record:TongueAbstract,at=new Date()) {
 await store.put(TONGUE_COLLECTION,localDay(at),parseTongueAbstract(record) as never)
}
export async function captureTongue(store:LocalStore,photo:TransientPhoto,context:AbstractContext,model:VisionClient,at=new Date()) {
 const result=await abstractTongue(photo,context,model)
 await saveTongue(store,result,at)
 return result
}
export async function loadTongue(store:LocalStore,date:string):Promise<TongueAbstract|null> {
 const value=await store.get(TONGUE_COLLECTION,date)
 return value?parseTongueAbstract(value):null
}
export async function listTongueDays(store:LocalStore):Promise<string[]> {
 return (await store.list(TONGUE_COLLECTION)).map(row=>row.key).sort()
}
