import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import {readFileSync} from 'node:fs'
import {actors,setActors} from './actors.mjs'
export const runtime=JSON.parse(readFileSync(process.env.E2E_RUNTIME_FILE!,'utf8'))
type Person={context:BrowserContext;page:Page;actor:typeof actors.teacher}
async function actualActor(page:Page){return page.evaluate(async()=>{const p='/src/core/store/index.ts',{resumeStore}=await import(p),session=await resumeStore();try{const value=await session.store.get('recovery-words','self');return {phrase:value?.words??'',pubkey:session.identity.publicKey,key:[...session.identity.privateKey]}}finally{session.store.close();session.identity.privateKey.fill(0)}})}
export const test=base.extend<{people:{teacher:Person;student:Person};seedLedger:boolean;communityOpen:boolean}>({
 seedLedger:[false,{option:true}],communityOpen:[true,{option:true}],
 people:async({browser,baseURL,request,seedLedger,communityOpen},use)=>{
  const headers={authorization:'Bearer '+runtime.resetToken}
  expect((await request.post(runtime.controlURL+'/reset',{headers,data:{communityOpen:true}})).status()).toBe(200)
  const tc=await browser.newContext({viewport:{width:375,height:812},baseURL}),sc=await browser.newContext({viewport:{width:375,height:812},baseURL})
  try{
   const teacher={context:tc,page:await tc.newPage(),actor:actors.teacher},student={context:sc,page:await sc.newPage(),actor:actors.student}
   await teacher.page.goto('/');await expect(teacher.page.getByRole('heading',{name:'您是老师还是学生？'})).toBeVisible()
   await teacher.page.getByRole('button',{name:'我是老师',exact:true}).click();await expect(teacher.page.getByRole('heading',{name:'老师首页',exact:true})).toBeVisible()
   await teacher.page.getByText('我是这个社区的老师',{exact:true}).click()
   await teacher.page.getByLabel('部署口令',{exact:true}).fill('SYNTHETIC_DEPLOYMENT_TOKEN')
   await teacher.page.getByRole('button',{name:'登记为社区老师',exact:true}).click();await expect(teacher.page.getByText('社区已建立，可以邀请学生。',{exact:true})).toBeVisible()
   await teacher.page.getByRole('button',{name:'邀请学生',exact:true}).click();const link=teacher.page.getByLabel('邀请链接',{exact:true});await expect(link).toBeVisible()
   await student.page.goto(await link.inputValue());await expect(student.page.getByRole('heading',{name:'问诊首页',exact:true})).toBeVisible()
   setActors(await actualActor(teacher.page),await actualActor(student.page))
   for(const page of [teacher.page,student.page])await expect(page.getByText('中继：已连接',{exact:true})).toBeVisible()
   if(!communityOpen){expect((await request.post(runtime.controlURL+'/reset',{headers,data:{communityOpen:false,members:[actors.teacher.pubkey,actors.student.pubkey],relayOnly:true}})).status()).toBe(200);for(const page of [teacher.page,student.page]){await page.reload();await expect(page.getByText('中继：已连接',{exact:true})).toBeVisible()}}
   if(seedLedger)await teacher.page.evaluate(async({teacher,student})=>{
    const runtimePath='/src/core/ledger/runtime.ts',storePath='/src/core/store/index.ts',syncPath='/src/core/ledger/sync.ts'
    const {restoreWithLedgerPaused}=await import(runtimePath)
    await restoreWithLedgerPaused(async()=>{const {resumeStore}=await import(storePath),session=await resumeStore(),{createLedgerSync}=await import(syncPath),sync=createLedgerSync({identity:session.identity,store:session.store,send:async()=>{throw Error('fixture queues funding while shared controller is paused')}});try{await sync.open(teacher,student);await sync.record(teacher,student,{type:'topup',amount:10})}finally{await sync.close();session.store.close();session.identity.privateKey.fill(0)}})
   },{teacher:actors.teacher.pubkey,student:actors.student.pubkey})
   await use({teacher,student})
  }finally{await tc.close();await sc.close()}
 }
})
export {expect}
