import {readFileSync} from 'node:fs'
import {afterEach, expect, it, vi} from 'vitest'
import {IDBFactory} from 'fake-indexeddb'
import {createIdentity} from '../identity'
import {openStore} from '../store'
import {abstractTongue, type TransientPhoto} from './index'
import {parseTongueFeatures, tongueSvg} from '../../../../domain/tcm/tongue'
import {createVisionClient} from '../llm/vision'

const features = {color:'pale',coatingColor:'white',coatingThickness:'thin',shape:'wide',teeth:['left-middle','right-middle'],cracks:['center'],confidence:0.7}
const context = {shichen:'辰',jieqi:'霜降',city:'合成城'}
// Fixed-path synthetic tongue raster; no person or medical photograph.
const PNG = readFileSync(new URL('./fixtures/tongue.png',import.meta.url)).toString('base64')
function photo():TransientPhoto {return {bytes:Uint8Array.from(atob(PNG), c=>c.charCodeAt(0)),type:'image/png'}}
const config = {provider:'qwen',baseUrl:'https://synthetic.example/v1',model:'qwen3-vl-plus',apiKey:'SYNTHETIC_KEY',testedAt:'2026-10-18'}
afterEach(()=>vi.unstubAllGlobals())

it('synthetic image -> features/SVG only; clears input and request references before result can be persisted or queued', async()=>{
 const input=photo(), original=input.bytes!
 const cache:unknown[]=[]
 const fetch=vi.fn(async(_url:string, init:RequestInit)=>{
  expect(init.cache).toBe('no-store');expect(init.credentials).toBe('omit');expect(init.redirect).toBe('error')
  const body=JSON.parse(init.body as string)
  expect(body.model).toBe(config.model)
  expect(body.messages[1].content[0].image_url.url).toBe('data:image/png;base64,'+PNG)
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(features)}}]}))
 });vi.stubGlobal('fetch',fetch)
 const result=await abstractTongue(input,context,createVisionClient(config))
 expect(input.bytes).toBeNull();expect(original.every(x=>x===0)).toBe(true)
 expect(result).toEqual({kind:'tongue',features:parseTongueFeatures(features),svg:tongueSvg(features),...context})
 // Real current LocalStore over IndexedDB, not a Map substitute. It receives only the result.
 const store=await openStore(createIdentity('leader monkey parrot ring guide accident before fence cannon height naive bean','english'),{factory:new IDBFactory(),name:crypto.randomUUID()})
 try {
  await store.put('abstract-records','synthetic',result as never)
  const queue=[JSON.stringify(result)];cache.push(result)
  const all=JSON.stringify({records:await store.list('abstract-records'),queue,cache})
  expect(all).not.toContain(PNG);expect(all).not.toContain('image_url');expect(all).not.toContain('data:image')
 } finally {store.close()}
})
it.each(['throw','bad-json','extra-data','invalid-enum'])('failure %s releases original and requests retake, with no model content in error',async mode=>{
 const input=photo(),bytes=input.bytes!;let captured:any
 const client={async describe(messages:any){captured=messages;if(mode==='throw')throw Error(PNG);if(mode==='bad-json')return PNG;if(mode==='extra-data')return JSON.stringify({...features,raw:PNG});return JSON.stringify({...features,color:'diagnosis'})}}
 await expect(abstractTongue(input,context,client)).rejects.toThrow('这次没看清，请重新拍一张')
 expect(input.bytes).toBeNull();expect(bytes.every(x=>x===0)).toBe(true)
 expect(JSON.stringify(captured)).not.toContain(PNG)
})
it('known text-only model refuses before sending and still clears original',async()=>{
 const input=photo(),bytes=input.bytes!,fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 await expect(abstractTongue(input,context,createVisionClient({...config,model:'qwen-turbo'}))).rejects.toThrow('请换用支持看图的模型')
 expect(fetch).not.toHaveBeenCalled();expect(input.bytes).toBeNull();expect(bytes.every(x=>x===0)).toBe(true)
})
it('HTTP image rejection requests vision model, other errors request retake; no fallback request',async()=>{
 for(const status of [400,401,429,500]){
  const fetch=vi.fn(async()=>new Response(PNG,{status}));vi.stubGlobal('fetch',fetch)
  await expect(abstractTongue(photo(),context,createVisionClient(config))).rejects.toThrow(status===400?'请换用支持看图的模型':'这次没看清，请重新拍一张')
  expect(fetch).toHaveBeenCalledTimes(1)
 }
})
it('SVG is deterministic, order-independent, uses fixed paths/palette only; unknown is not normal',()=>{
 const svg=tongueSvg(features)
 expect(svg).toBe(tongueSvg({...features,teeth:[...features.teeth].reverse()}))
 expect(svg).toContain('<svg');expect(svg).not.toMatch(/<image|href=|script|data:|foreignObject/)
 expect(tongueSvg({...features,color:'unknown',shape:'unknown'})).toContain('未知')
 expect(()=>tongueSvg({...features,color:'<script>'})).toThrow()
})
it('validates confidence, positions, duplicate marks and missing observations instead of guessing',()=>{
 for(const patch of [{confidence:1.1},{confidence:null},{teeth:['center']},{cracks:['center','center']},{shape:undefined}])expect(()=>parseTongueFeatures({...features,...patch})).toThrow()
 expect(parseTongueFeatures({...features,teeth:null,cracks:null}).teeth).toBeNull()
})
it('bad image/context rejected without a model request, always releasing bytes',async()=>{
 const client={describe:vi.fn()};const input=photo(),bytes=input.bytes!
 await expect(abstractTongue(input,{...context,city:'data:image/png;base64,'+PNG},client)).rejects.toThrow()
 expect(client.describe).not.toHaveBeenCalled();expect(input.bytes).toBeNull();expect(bytes.every(x=>x===0)).toBe(true)
})

it('request timeout is bounded and clears original, even when provider never responds',async()=>{
 const input=photo(),bytes=input.bytes!
 const fetch=vi.fn(async(_url:string,init:RequestInit)=>new Promise<Response>((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason))))
 vi.stubGlobal('fetch',fetch)
 await expect(abstractTongue(input,context,createVisionClient(config,10))).rejects.toThrow('这次没看清，请重新拍一张')
 expect(input.bytes).toBeNull();expect(bytes.every(x=>x===0)).toBe(true);expect(fetch).toHaveBeenCalledTimes(1)
})
