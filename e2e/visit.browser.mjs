import {chromium,expect} from '@playwright/test'
import {createServer} from '../app/node_modules/vite/dist/node/index.js'
import {fileURLToPath} from 'node:url'
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\\/g,'/')
const server=await createServer({configFile:root+'app/vite.config.ts',root:root+'app',server:{host:'127.0.0.1',port:0},resolve:{alias:{react:root+'app/node_modules/react','react-dom':root+'app/node_modules/react-dom'}}})
await server.listen();const browser=await chromium.launch({headless:true})
try {
 for (const width of [375,1280]) {
  const page=await browser.newPage({viewport:{width,height:844}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{
   const track={onended:null,stop(){}};window.__fakeTrack=track
   Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getAudioTracks:()=>[track],getTracks:()=>[track]})}})
   class Recorder {state='inactive';mimeType='audio/webm';ondataavailable=null;onstop=null;onerror=null;start(){this.state='recording'}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['synthetic'],{type:'audio/webm'})});this.onstop?.()}}
   class Recognition {lang='';continuous=false;interimResults=false;onresult=null;onend=null;onerror=null;start(){window.__fakeSpeech=this}stop(){this.onresult?.({resultIndex:0,results:Object.assign([[{transcript:'合成原话'}]],{0:Object.assign([{transcript:'合成原话'}],{isFinal:true})})});this.onend?.()}}
   window.MediaRecorder=Recorder;window.SpeechRecognition=Recognition
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${root}e2e/visit-harness.html`)
  await expect(page.getByRole('button',{name:'开始录音'})).toBeVisible()
  const buttonBackground=await page.getByRole('button',{name:'开始录音'}).evaluate(element=>getComputedStyle(element).backgroundColor)
  expect(buttonBackground).not.toBe('rgba(0, 0, 0, 0)');expect(buttonBackground).not.toBe('rgb(255, 255, 255)')
  await page.getByRole('button',{name:'开始录音'}).click();await expect(page.getByText(/正在录音/)).toBeVisible()
  await page.getByRole('button',{name:'停止录音'}).click()
  const suggestions=page.getByRole('region',{name:'录音整理草稿'})
  await expect(suggestions).toContainText('合成主诉');await expect(suggestions).toContainText('第 1 句')
  for(const label of ['合成现病史','合成望','合成闻','合成问','合成切'])await expect(suggestions).toContainText(label)
  await expect(page.getByRole('button',{name:'拍患处'})).toBeVisible()
  await expect(page.getByRole('button',{name:'拍舌象 / 重拍'})).toBeVisible()
  await page.getByLabel('照片说明（部位、样子）').fill('合成照片说明')
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const context=canvas.getContext('2d');context.fillStyle='#ccc';context.fillRect(0,0,32,32);return canvas.toDataURL('image/png').split(',')[1]})
  await page.getByLabel('选择患处照片').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')})
  await expect(page.getByRole('region',{name:'患处照片'})).toContainText('合成照片说明')
  await expect(page.locator('audio')).toHaveCount(1)
  await page.getByRole('region',{name:'面诊基本记录'}).locator('textarea').first().fill('合成老师改过')
  await page.getByLabel('识别语言').selectOption('yue-Hant-HK')
  await page.getByRole('button',{name:'开始录音'}).click()
  expect(await page.evaluate(()=>window.__fakeSpeech.lang)).toBe('yue-Hant-HK')
  await page.evaluate(()=>window.__fakeTrack.onended())
  await expect(page.getByRole('button',{name:'开始录音'})).toBeVisible()
  await expect(page.getByRole('region',{name:'面诊基本记录'}).locator('textarea').first()).toHaveValue('合成老师改过')
  await expect(page.getByRole('region',{name:'逐句原话'})).toContainText('第 2 句')
  await expect(page.locator('audio')).toHaveCount(2)
  await page.getByRole('button',{name:'开始录音'}).click()
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))})
  await expect(page.getByRole('region',{name:'逐句原话'})).toContainText('第 3 句')
  expect(errors).toEqual([])
  await page.close()
 }
 console.log('V2-40 synthetic browser recording and six-field draft: passed at 375 and 1280 px')
} finally {await browser.close();await server.close()}
