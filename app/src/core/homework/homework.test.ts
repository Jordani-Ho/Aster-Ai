import { afterEach, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { Solar } from 'lunar-typescript'
import { shichenAt, meridians, jieqiDate } from '../../../../domain/tcm/calendar'
import { schedule, localDay } from './schedule'
import { checkIn, listCheckins, sevenDayProgress } from './index'
import { createIdentity } from '../identity'
import { openStore } from '../store'
import type { Homework } from '../record/types'
const homework:Homework={id:'synthetic-task',title:'合成作业',detail:'仅合成测试',source:'teacher',schedule:{kind:'daily',time:'08:00'}}
afterEach(()=>{vi.unstubAllGlobals()})
it('1 时辰跨日边界',()=>{
 for(const [h,m,name] of [[22,59,'亥'],[23,0,'子'],[0,59,'子'],[1,0,'丑']] as const) expect(shichenAt(new Date(2026,0,1,h,m)).name).toBe(name)
})
it('2 十二条经络与数据一致，各有出处',()=>{
 expect(meridians).toHaveLength(12)
 expect(meridians.map(row=>row.meridian)).toEqual(['胆','肝','肺','大肠','胃','脾','心','小肠','膀胱','肾','心包','三焦'])
 expect(meridians.every(row=>row.source.url.startsWith('https://') && row.source.title.length>0)).toBe(true)
})
it('3 酉时持续3天每天17点，5 超期不再提醒',()=>{
 const result=schedule([{...homework,schedule:{kind:'shichen',shichen:'酉'},durationDays:3}],'2026-10-01',10)
 expect(result).toHaveLength(3)
 expect(result.map(item=>item.at.getHours())).toEqual([17,17,17])
 expect(result.map(item=>localDay(item.at))).toEqual(['2026-10-01','2026-10-02','2026-10-03'])
})
it('4 立冬日期与获批历法库一致，当天本地8点',()=>{
 const expected=Solar.fromYmd(2026,6,1).getLunar().getJieQiTable()['立冬'].toYmd()
 expect(jieqiDate(2026,'立冬')).toBe(expected)
 const result=schedule([{...homework,schedule:{kind:'jieqi',jieqi:'立冬'}}],'2026-01-01',365)
 expect(result).toHaveLength(1)
 expect(localDay(result[0].at)).toBe(expected)
 expect(result[0].at.getHours()).toBe(8)
})
it('daily与once支持指定时间，默认once为8点；错误输入明确拒绝',()=>{
 expect(schedule([homework],'2026-10-01',2)).toHaveLength(2)
 expect(schedule([{...homework,schedule:{kind:'once',date:'2026-10-02'}}],'2026-10-01',3)[0].at.getHours()).toBe(8)
 expect(()=>schedule([{...homework,schedule:{kind:'daily',time:'25:00'}}],'2026-10-01',2)).toThrow()
 expect(()=>schedule([homework],'2026-02-30',2)).toThrow()
})
it('6 打卡可读取且本机明存（V2 不再加密）；7全流程无fetch或WebSocket；8完成5天显示5/7',async()=>{
 const fetcher=vi.fn(()=>{throw Error('network forbidden')})
 const socket=vi.fn(()=>{throw Error('network forbidden')})
 vi.stubGlobal('fetch',fetcher);vi.stubGlobal('WebSocket',socket)
 const factory=new IDBFactory(), name=crypto.randomUUID()
 const identity=createIdentity()
 const store=await openStore(identity,{factory,name})
 try {
 for(let i=1;i<=5;i++) await checkIn(store,homework.id,'SYNTHETIC_PRIVATE_NOTE',new Date(2026,9,i,9))
 // 同一天多次打卡不增加已完成天数
 await checkIn(store,homework.id,undefined,new Date(2026,9,1,10))
 const rows=await listCheckins(store)
 expect(rows).toHaveLength(6)
 expect(rows[0].homeworkId).toBe(homework.id)
 const progress=sevenDayProgress(homework,rows,'2026-10-01',new Date(2026,9,7,12))
 expect(progress.completed).toBe(5);expect(progress.expected).toBe(7)
 expect(sevenDayProgress({...homework,durationDays:3},rows,'2026-10-01',new Date(2026,9,7,12)).expected).toBe(3)
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=factory.open(name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
 const raw=await new Promise(resolve=>{const tx=db.transaction('records');const r=tx.objectStore('records').getAll();tx.oncomplete=()=>resolve(r.result)})
 db.close()
 // V2：本机存储是普通 IndexedDB，业务值明文保存；仍不联网。
 expect(JSON.stringify(raw)).toContain('SYNTHETIC_PRIVATE_NOTE')
 expect(JSON.stringify(raw)).toContain(homework.id)
 expect(fetcher).not.toHaveBeenCalled();expect(socket).not.toHaveBeenCalled()
 } finally {store.close()}
})
it('窗口不会重置有效期，跨年/闰日排程正确，作业到点且未完成才提醒', async()=>{
 const {dueReminders}=await import('./index')
 expect(schedule([{...homework,durationDays:3}],'2026-10-01',7,'2026-10-03')).toHaveLength(1)
 expect(schedule([homework],'2028-02-28',3).map(item=>localDay(item.at))).toEqual(['2028-02-28','2028-02-29','2028-03-01'])
 const assignments=[{homework,startsOn:'2026-10-01'}]
 expect(dueReminders(assignments,[],new Date(2026,9,1,7,59))).toHaveLength(0)
 expect(dueReminders(assignments,[],new Date(2026,9,1,8))).toHaveLength(1)
 expect(dueReminders(assignments,[{homeworkId:homework.id,at:new Date(2026,9,1,8).toISOString()}],new Date(2026,9,1,9))).toHaveLength(0)
})
it('夏令时切换按本地日历逐日生成而非加24小时',()=>{
 const previous=process.env.TZ
 process.env.TZ='America/Los_Angeles'
 try{
 const reminders=schedule([homework],'2026-03-07',3)
 expect(reminders.map(item=>item.at.getHours())).toEqual([8,8,8])
 expect(reminders.map(item=>localDay(item.at))).toEqual(['2026-03-07','2026-03-08','2026-03-09'])
 }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous}
})
it('冬至取本年DONG_ZHI而不是表中的上年冬至，跨年窗口各年只提醒一次',()=>{
 const table=Solar.fromYmd(2026,6,1).getLunar().getJieQiTable()
 expect(jieqiDate(2026,'冬至')).toBe(table.DONG_ZHI.toYmd())
 const reminders=schedule([{...homework,schedule:{kind:'jieqi',jieqi:'冬至'}}],'2026-12-01',400)
 expect(reminders).toHaveLength(2)
 expect(reminders.map(item=>item.at.getFullYear())).toEqual([2026,2027])
})
