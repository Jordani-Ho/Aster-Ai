import {test,expect,runtime,fulfillFromModel} from './fixtures'
import type {Page} from '@playwright/test'
async function form(page:Page){await page.getByLabel('选择服务商',{exact:true}).selectOption('other');await page.getByLabel('接口地址',{exact:true}).fill('https://model.synthetic.example/v1');await page.getByLabel('模型名称',{exact:true}).fill('synthetic-fixture');await page.getByLabel('接入凭证',{exact:true}).fill('SYNTHETIC_PERSONAL_TOKEN')}
test('M1-21 role then mandatory real account test; 401/402/network plain errors never unlock through house',async({people,browser})=>{
 const context=await browser.newContext({baseURL:runtime.baseURL,viewport:{width:375,height:812}}),page=await context.newPage();let mode=401,house=0
 await context.route('https://model.synthetic.example/**',route=>mode===0?route.abort('failed'):route.fulfill({status:mode,contentType:'application/json',body:'SYNTHETIC_RAW_ENGLISH_ERROR'}))
 await context.route('**/v1/proxy',route=>route.abort('failed'))
 page.on('request',r=>{if(r.url()===runtime.baseURL+'/v1/chat/completions')house++})
 try{
 await page.goto('/');await page.getByRole('button',{name:'我是学生',exact:true}).click();await expect(page.getByRole('heading',{name:'接入您的大模型',exact:true})).toBeVisible();await expect(page.locator('[data-page=student-today]')).toHaveCount(0);await expect(page.getByRole('button',{name:'进入首页',exact:true})).toHaveCount(0)
 await form(page)
 for(const [status,text] of [[401,'接入凭证不对'],[402,'账户余额不足'],[0,'网络暂时不通']] as const){mode=status;await page.getByRole('button',{name:'测试连接',exact:true}).click();await expect(page.getByRole('alert')).toContainText(text);await expect(page.getByRole('button',{name:'进入首页',exact:true})).toHaveCount(0);expect(await page.locator('body').innerText()).not.toMatch(/SYNTHETIC_RAW|密钥|公钥/)}
 expect(house).toBe(0)
 await context.unroute('https://model.synthetic.example/**');await context.route('https://model.synthetic.example/**',fulfillFromModel)
 await page.getByRole('button',{name:'测试连接',exact:true}).click();await expect(page.getByText('✓ 连接成功',{exact:true})).toBeVisible()
 await page.getByLabel('模型名称',{exact:true}).fill('changed');await expect(page.getByRole('button',{name:'进入首页',exact:true})).toHaveCount(0)
 await page.getByRole('button',{name:'测试连接',exact:true}).click();await expect(page.getByText('✓ 连接成功',{exact:true})).toBeVisible();if(!process.env.CI)await page.screenshot({path:'docs/screenshots/model-connect-375.png'});await page.getByRole('button',{name:'进入首页',exact:true}).click();await expect(page.locator('[data-page=student-today]')).toBeVisible();await page.reload();await expect(page.locator('[data-page=student-today]')).toBeVisible()
 if(!process.env.CI)await page.screenshot({path:'docs/screenshots/model-connected-375.png'})
 }finally{await context.close()}
})
test('M1-21 browser network rejection proxies through actual signed member gateway',async({people})=>{
 const page=people.teacher.page;await people.teacher.context.route('https://model.synthetic.example/**',r=>r.abort('failed'));let proxies=0;page.on('request',r=>{if(r.url().endsWith('/v1/proxy'))proxies++})
 const reply=await page.evaluate(async()=>{const a='/src/core/store/index.ts',b='/src/core/llm/personal.ts',s=await(await import(a)).resumeStore();try{const {loadPersonalModel,testConnection}=await import(b),config=await loadPersonalModel(s.store);await testConnection(config,{baseUrl:location.origin+'/v1',secretKey:s.identity.privateKey});return true}finally{s.store.close();s.identity.privateKey.fill(0)}})
 expect(reply).toBe(true);expect(proxies).toBe(1)
})
test('M1-21 account failure shows house notice; switch off gives fixed intake questions',async({people,request})=>{
 const page=people.student.page
 // 先等首次建议写入缓存，再删缓存制造后备场景；不能与首页的在途写入竞争。
 await page.getByText('今天的完整建议',{exact:true}).click()
 await expect(page.getByRole('region',{name:'每日建议'})).toContainText('SYNTHETIC_DAILY')
 await people.student.context.route('https://model.synthetic.example/**',r=>r.fulfill({status:402,body:'SYNTHETIC_BALANCE_ERROR'}))
 await page.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{for(const r of await s.store.list('mirror'))await s.store.delete('mirror',r.key)}finally{s.store.close();s.identity.privateKey.fill(0)}});await page.reload()
 await expect(page.getByText('今天用的是备用模型，请检查您的模型账户',{exact:true})).toBeVisible()
 expect((await request.post(runtime.controlURL+'/reset',{headers:{authorization:'Bearer '+runtime.resetToken},data:{relayOnly:true,fallbackEnabled:false}})).status()).toBe(200)
 await page.getByRole('button',{name:/不舒服？告诉/}).click();await page.getByLabel('按键盘上的🎤说话就行').fill('SYNTHETIC_NETWORK_FALLBACK');await page.getByRole('button',{name:'发送',exact:true}).click();await expect(page.getByText('模型暂不可用，已改用固定问句。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'跳过',exact:true})).toBeVisible()
})

test('M1-21 settings changes require retest and failed change preserves encrypted working account',async({people})=>{
 const page=people.student.page
 await page.getByRole('button',{name:'我',exact:true}).click();await page.locator('summary').filter({hasText:/^设置$/}).click();await page.getByText('我的大模型',{exact:true}).first().click()
 const region=page.getByRole('region',{name:'模型接入',exact:true})
 expect(await region.getByLabel('接入凭证',{exact:true}).inputValue()).toBe('')
 await region.getByLabel('接入凭证',{exact:true}).fill('SYNTHETIC_NEW_TOKEN')
 await people.student.context.route('https://model.synthetic.example/**',r=>r.fulfill({status:401,body:'SYNTHETIC_REJECTED'}))
 await region.getByRole('button',{name:'测试连接',exact:true}).click();await expect(region.getByRole('alert')).toContainText('接入凭证不对');await expect(region.getByRole('button',{name:'保存接入',exact:true})).toHaveCount(0)
 const token=()=>page.evaluate(async()=>{const p='/src/core/store/index.ts',s=await(await import(p)).resumeStore();try{return (await s.store.get('settings','personal-model')).apiKey}finally{s.store.close();s.identity.privateKey.fill(0)}})
 expect(await token()).toBe('SYNTHETIC_PERSONAL_TOKEN')
 await people.student.context.unroute('https://model.synthetic.example/**');await people.student.context.route('https://model.synthetic.example/**',fulfillFromModel)
 await region.getByRole('button',{name:'测试连接',exact:true}).click();await expect(region.getByText('✓ 连接成功',{exact:true})).toBeVisible();await region.getByRole('button',{name:'保存接入',exact:true}).click();await expect.poll(token).toBe('SYNTHETIC_NEW_TOKEN')
 await page.reload();await expect(page.locator('[data-page=student-today]')).toBeVisible();expect(await token()).toBe('SYNTHETIC_NEW_TOKEN')
})
