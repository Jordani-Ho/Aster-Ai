import { describe,it,expect } from 'vitest'
import { prioritizeConsults,urgentConsult } from './priority'
import { startInPersonEncounter } from '../record/in-person'
import type { StoredConsult } from './index'
function row(text:string,at:string):StoredConsult{const encounter=startInPersonEncounter({teacher:'a'.repeat(64),student:'b'.repeat(64)});encounter.intake.chiefComplaint={value:text,source:'student'};return {encounter,receivedAt:at,sender:encounter.student,history:[],attachments:[],droppedHistory:0}}
describe('老师工作台急症优先',()=>{it('今天、远程共用排序，急症即使后来收到仍在前面，输入不变',()=>{const normal=row('合成睡眠记录','2026-10-17T08:00:00Z'),urgent=row('胸痛伴出汗','2026-10-17T09:00:00Z'),rows=[normal,urgent];expect(urgentConsult(urgent)).toBe(true);expect(prioritizeConsults(rows)).toEqual([urgent,normal]);expect(rows).toEqual([normal,urgent])})})
