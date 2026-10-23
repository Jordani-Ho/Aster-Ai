import {test,expect,runtime,connectModel,mockModel} from './fixtures'
import {actors} from './actors.mjs'
const forbidden=/密钥|公钥|npub|十六进制/
async function settings(page:import('@playwright/test').Page){const manage=page.getByRole('button',{name:'我的馆',exact:true});if(await manage.count())await manage.click();const me=page.getByRole('button',{name:'我',exact:true});if(await me.count())await me.click();const summary=page.locator('summary').filter({hasText:/^设置$/});if(await summary.locator('..').getAttribute('open')===null)await summary.click()}
test('first open asks role then model; invitation automatically registers student and automatically adds teacher and book',async({people,browser})=>{
 const fresh=await browser.newContext({baseURL:runtime.baseURL,viewport:{width:375,height:812}})
 try{await mockModel(fresh);const page=await fresh.newPage();await page.goto('/');await expect(page.getByRole('heading',{name:'您是老师还是学生？'})).toBeVisible();expect(await page.locator('body').innerText()).not.toMatch(forbidden);await page.getByRole('button',{name:'我是老师',exact:true}).click();await expect(page.getByText('第 1 步，共 5 步',{exact:true})).toBeVisible();await connectModel(page);await expect(page.getByRole('heading',{name:'登记为社区老师',exact:true})).toBeVisible();
  // 建馆没走完：没有管理/钱账/换门面入口，页面上也没有技术词。真实首位学生加入由 opening.spec 覆盖。
  expect(await page.getByRole('button',{name:'管理',exact:true}).count()).toBe(0);expect(await page.getByText('换门面',{exact:true}).count()).toBe(0);expect(await page.getByText('钱账',{exact:true}).count()).toBe(0);expect(await page.locator('body').innerText()).not.toMatch(forbidden)}finally{await fresh.close()}
 const student=people.student.page
 const state=await student.evaluate(async()=>{const p='/src/core/store/index.ts',session=await(await import(p)).resumeStore();try{return {teachers:await session.store.get('settings','teachers'),books:await session.store.list('ledger-index')}}finally{session.store.close();session.identity.privateKey.fill(0)}})
 expect(state.teachers).toContain(actors.teacher.pubkey);expect(state.books.some((v:any)=>v.value.teacher===actors.teacher.pubkey)).toBe(true)
 await student.getByRole('button',{name:'我',exact:true}).click();await settings(student);await expect(student.getByRole('region',{name:'我的老师'})).toBeVisible();expect(await student.locator('body').innerText()).not.toMatch(forbidden)
 await settings(people.teacher.page);expect(await people.teacher.page.locator('body').innerText()).not.toMatch(forbidden)
 await people.teacher.page.getByRole('button',{name:'我的馆',exact:true}).click()
 await people.teacher.page.locator('summary').filter({hasText:/^邀请学生$/}).click();await people.teacher.page.getByRole('button',{name:'生成邀请',exact:true}).click();await expect(people.teacher.page.getByAltText('学生扫码即可加入')).toBeVisible()
})
test('expired and nonmember invitation links fail with plain explanation and no registration',async({people,browser})=>{
 const links=await people.teacher.page.evaluate(async({outsider,base})=>{const p='/src/core/onboarding/index.ts',q='/src/core/store/index.ts',identity='/src/core/identity/index.ts',{makeInvite,inviteLink}=await import(p),session=await(await import(q)).resumeStore();try{const other=(await import(identity)).identityFromPrivateKey(Uint8Array.from(outsider)),url=base+'/invite/redeem';return [inviteLink(base,makeInvite(session.identity,url,Math.floor(Date.now()/1000)-604801)),inviteLink(base,makeInvite(other,url))]}finally{session.store.close();session.identity.privateKey.fill(0)}},{outsider:actors.outsider.key,base:runtime.baseURL})
 // V2-09：过期邀请不显示门面，直接提示；非成员邀请先看首屏，点“开始使用”后才被网关拒绝。
 for(const [index,link] of links.entries()){const context=await browser.newContext();try{const page=await context.newPage();await page.goto(link);if(index===1){await page.getByRole('button',{name:'开始使用',exact:true}).click()};await expect(page.getByText('邀请暂不可用，请向老师要一个新链接',{exact:true})).toBeVisible();expect(await page.locator('body').innerText()).not.toMatch(forbidden);expect(await page.locator('[data-page=student-today]').count()).toBe(0)}finally{await context.close()}}
})
test('community_open accepts any authenticated identity but rejects anonymous subscriptions',async({people})=>{
 const result=await people.teacher.page.evaluate(async({key,url})=>{const p='/src/core/transport/index.ts',{createTransport}=await import(p);return new Promise(resolve=>{const transport=createTransport({privateKey:Uint8Array.from(key),relays:[url],onMessage:()=>{},onStatus:(status:string)=>{if(status==='ready'||status==='rejected'){transport.close();resolve(status)}}});transport.start()})},{key:actors.outsider.key,url:runtime.relayUrl});expect(result).toBe('ready')
 const anonymous=await people.teacher.page.evaluate(url=>new Promise(resolve=>{const socket=new WebSocket(url);socket.onopen=()=>socket.send(JSON.stringify(['REQ','anonymous',{kinds:[1059]}]));socket.onmessage=({data})=>{const frame=JSON.parse(data);if(frame[0]==='CLOSED'){socket.close();resolve(frame[2])}}}),runtime.relayUrl);expect(anonymous).toContain('auth-required')
})
