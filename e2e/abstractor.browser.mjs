import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\\/g,'/')
const server=await createServer({configFile:root+'app/vite.config.ts',root:root+'app',server:{host:'127.0.0.1',port:0},resolve:{alias:{react:root+'app/node_modules/react','react-dom':root+'app/node_modules/react-dom'}}})
await server.listen()
const browser=await chromium.launch({headless:true})
try {
 const page=await browser.newPage({viewport:{width:375,height:812}})
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 const png=await readFile(new URL('../app/src/core/abstractor/fixtures/tongue.png',import.meta.url)), image=png.toString('base64')
 const features={color:'pale',coatingColor:'white',coatingThickness:'thin',shape:'wide',teeth:[],cracks:[],confidence:0.7,box:{x:0.2,y:0.2,width:0.6,height:0.6},lightingNote:false}
 let failure=false,requests=0
 await page.route('https://synthetic.invalid/**',async route=>{requests++;await route.fulfill({status:failure?500:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify(features)}}]})})})
 await page.route('https://geocoding-api.open-meteo.com/**',route=>route.fulfill({status:200,body:'{}'}))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${root}e2e/abstractor.html`)
 // Vite 首次启动可能在页面加载后重载一次（依赖预构建），等它稳定再操作，否则上传会被重载打断。
 await page.waitForLoadState('networkidle');await page.waitForTimeout(2500)
 const upload=async()=>{await page.locator('input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:png});await expect(page.locator('input[type=file]')).toHaveValue('')}
 await expect(page.locator('[data-page=student-today]')).toBeVisible()
 const mirrorSvg=page.locator('.nl-mirror-frame svg')
 await upload();await expect(mirrorSvg).toHaveCount(1)
 await page.reload();await expect(mirrorSvg).toHaveCount(1)
 failure=true;await upload();await expect(page.getByRole('alert')).toContainText('稍后再拍');await expect(mirrorSvg).toHaveCount(1)
 failure=false;await page.getByText('切换家人',{exact:true}).click();await expect(mirrorSvg).toHaveCount(0)
 await upload();await expect(mirrorSvg).toHaveCount(1)
 await page.getByText('切换页面',{exact:true}).click();await expect(page.getByRole('heading',{name:'看一眼，再发出'})).toBeVisible()
 await page.getByRole('button',{name:/去拍/}).click()
 await upload();await expect(page.locator('figure svg')).toHaveCount(1)
 await page.reload()
 await expect(page.locator('[data-page=student-today]')).toBeVisible()
 await expect.poll(async()=>page.evaluate(async()=>(await window.inspectAbstractor()).familyDraft?.tongues?.length)).toBe(1)
 const familyButton=page.getByRole('button',{name:'切换家人',exact:true})
 await familyButton.click();await expect(familyButton).toHaveAttribute('aria-pressed','true')
 await page.getByText('切换页面',{exact:true}).click()
 await expect(page.getByRole('heading',{name:'看一眼，再发出'})).toBeVisible()
 await expect(page.locator('figure svg')).toHaveCount(1)
 await page.getByRole('button',{name:'发给老师',exact:true}).click();await expect(page.getByRole('heading',{name:'已发给老师'})).toBeVisible()
 const data=await page.evaluate(()=>window.inspectAbstractor())
 expect(data.root).toHaveLength(1);expect(data.family).toHaveLength(1);expect(data.teacher).toHaveLength(1)
 expect(data.sent[0].payload.encounter.intake.tongues).toHaveLength(1)
 const dump=JSON.stringify(data);expect(dump).not.toContain(image);expect(dump).not.toContain('data:image');expect(dump).not.toContain('image_url')
 expect(errors).toEqual([]);console.log(`PASS: mirror/reload/failure/retake/family/consult/draft/send/IndexedDB; ${requests} synthetic vision requests`)
} finally {await browser.close();await server.close()}
