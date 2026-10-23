import { test as base, expect, type BrowserContext, type Page, type Route } from '@playwright/test'
import {readFileSync} from 'node:fs'
import {actors,setActors} from './actors.mjs'
export const runtime=JSON.parse(readFileSync(process.env.E2E_RUNTIME_FILE!,'utf8'))
type Person={context:BrowserContext;page:Page;actor:typeof actors.teacher}
export async function fulfillFromModel(route:Route){
 // New short-lived local connection avoids stale APIRequestContext keep-alive sockets.
 const response=await fetch(runtime.upstreamUrl+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:route.request().headers().authorization??'',connection:'close'},body:route.request().postData()})
 await route.fulfill({status:response.status,contentType:response.headers.get('content-type')??'application/json',body:Buffer.from(await response.arrayBuffer())})
}
export async function mockModel(context:BrowserContext){
 await context.route('https://model.synthetic.example/v1/chat/completions',fulfillFromModel)
}
export async function connectModel(page:Page){
 // V2-17：老师第一次进来是五步建馆引导（第 1 步接模型）；学生仍是“接入您的大模型”。
 if(await page.getByRole('heading',{name:'让它帮您打理馆',exact:true}).isVisible().catch(()=>false)){
  await page.getByRole('button',{name:'其他',exact:true}).click()
  await page.getByLabel('接口地址',{exact:true}).fill('https://model.synthetic.example/v1')
  await page.getByLabel('模型名称',{exact:true}).fill('synthetic-fixture')
  await page.getByLabel('模型账户密钥',{exact:true}).fill('SYNTHETIC_PERSONAL_TOKEN')
  await page.getByRole('button',{name:'测试并继续',exact:true}).click()
  await expect(page.getByRole('heading',{name:'先登记您这位老师',exact:true})).toBeVisible()
  return
 }
 await expect(page.getByRole('heading',{name:'接入您的大模型',exact:true})).toBeVisible()
 await page.getByLabel('选择服务商',{exact:true}).selectOption('other')
 await page.getByLabel('接口地址',{exact:true}).fill('https://model.synthetic.example/v1')
 await page.getByLabel('模型名称',{exact:true}).fill('synthetic-fixture')
 await page.getByLabel('接入凭证',{exact:true}).fill('SYNTHETIC_PERSONAL_TOKEN')
 await page.getByRole('button',{name:'测试连接',exact:true}).click()
 await expect(page.getByText('✓ 连接成功',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'进入首页',exact:true}).click()
}
/** V2-17 建馆引导第 2–5 步：登记、给馆起名、开馆、返回第一位学生的 1 小时邀请。 */
export async function openCommunity(page:Page):Promise<string>{
 await expect(page.getByRole('heading',{name:'先登记您这位老师',exact:true})).toBeVisible()
 await page.getByLabel('学生怎么称呼您',{exact:true}).fill('合成老师')
 await page.getByLabel('登记口令',{exact:true}).fill('SYNTHETIC_DEPLOYMENT_TOKEN')
 await page.getByRole('button',{name:'登记，下一步',exact:true}).click()
 await expect(page.getByRole('heading',{name:'给您的馆起个名',exact:true})).toBeVisible()
 await page.getByLabel('馆名',{exact:true}).fill('合成养生馆')
 await page.getByLabel('一句介绍',{exact:true}).fill('一起照顾日常作息。')
 await page.getByRole('button',{name:'就用这个名字',exact:true}).click()
 await expect(page.getByText('✓ 模型已接好',{exact:true})).toBeVisible()
 await page.getByRole('button',{name:'开馆',exact:true}).click()
 await expect(page.getByRole('heading',{name:'请第一位学生进来',exact:true})).toBeVisible()
 await page.locator('details.op-link-details > summary').click()
 const link=page.getByLabel('邀请链接',{exact:true})
 await expect(link).toBeVisible()
 return link.inputValue()
}
async function actualActor(page:Page){return page.evaluate(async()=>{const p='/src/core/store/index.ts',{resumeStore}=await import(p),session=await resumeStore();try{return {pubkey:session.identity.publicKey,key:[...session.identity.privateKey]}}finally{session.store.close();session.identity.privateKey.fill(0)}})}
export const test=base.extend<{people:{teacher:Person;student:Person};seedLedger:boolean;communityOpen:boolean}>({
 seedLedger:[false,{option:true}],communityOpen:[true,{option:true}],
 people:async({browser,baseURL,request,seedLedger,communityOpen},use)=>{
  const headers={authorization:'Bearer '+runtime.resetToken}
  expect((await request.post(runtime.controlURL+'/reset',{headers,data:{communityOpen:true}})).status()).toBe(200)
  const tc=await browser.newContext({viewport:{width:375,height:812},baseURL}),sc=await browser.newContext({viewport:{width:375,height:812},baseURL})
  try{
   await mockModel(tc);await mockModel(sc)
   const teacher={context:tc,page:await tc.newPage(),actor:actors.teacher},student={context:sc,page:await sc.newPage(),actor:actors.student}
   await teacher.page.goto('/');await expect(teacher.page.getByRole('heading',{name:'您是老师还是学生？'})).toBeVisible()
   await teacher.page.getByRole('button',{name:'我是老师',exact:true}).click();await connectModel(teacher.page)
   // V2-15：第一次进来走建馆引导，开馆后拿到第一位学生的 1 小时邀请。
   const link=await openCommunity(teacher.page)
   await student.page.goto(link);await expect(student.page.getByRole('button',{name:'开始使用',exact:true})).toBeVisible();await student.page.getByRole('button',{name:'开始使用',exact:true}).click();await connectModel(student.page);await expect(student.page.locator('[data-page=student-today]')).toBeVisible()
   // 学生连上社区后老师才认得他；建馆引导自动结束，进入正常首页。
   await expect(teacher.page.getByRole('heading',{name:'今天',exact:true})).toBeVisible()
   setActors(await actualActor(teacher.page),await actualActor(student.page))
   for(const page of [teacher.page,student.page])await expect(page.getByText('中继：已连接',{exact:true})).toBeVisible()
   if(!communityOpen){expect((await request.post(runtime.controlURL+'/reset',{headers,data:{communityOpen:false,members:[actors.teacher.pubkey,actors.student.pubkey],relayOnly:true}})).status()).toBe(200);for(const page of [teacher.page,student.page]){await page.reload();await expect(page.getByText('中继：已连接',{exact:true})).toBeVisible()}}
   if(seedLedger)await teacher.page.evaluate(async({teacher,student})=>{
    const runtimePath='/src/core/ledger/runtime.ts',storePath='/src/core/store/index.ts',syncPath='/src/core/ledger/sync.ts'
    const {restoreWithLedgerPaused}=await import(runtimePath)
    await restoreWithLedgerPaused(async()=>{const {resumeStore}=await import(storePath),session=await resumeStore(),{createLedgerSync}=await import(syncPath),sync=createLedgerSync({identity:session.identity,store:session.store,send:async()=>{throw Error('fixture queues funding while shared controller is paused')}});try{await sync.open(teacher,student);await sync.record(teacher,student,{type:'topup', currency: 'CNY',amount:1000})}finally{await sync.close();session.store.close();session.identity.privateKey.fill(0)}})
   },{teacher:actors.teacher.pubkey,student:actors.student.pubkey})
   await teacher.page.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{await s.store.put('settings','money-currency','CNY')}finally{s.store.close();s.identity.privateKey.fill(0)}})
   await use({teacher,student})
  }finally{await tc.close();await sc.close()}
 }
})
export {expect}
