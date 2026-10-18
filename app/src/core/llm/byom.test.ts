import {afterEach,expect,it,vi} from 'vitest'
import {generateSecretKey} from 'nostr-tools/pure'
import {createPersonalClient, testConnection, connectionError} from './personal'
const config={provider:'other',baseUrl:'https://synthetic.example/v1',model:'synthetic',apiKey:'SYNTHETIC_SECRET',testedAt:'2026-10-17T00:00:00Z'}
const gateway={baseUrl:'https://gateway.example/v1',secretKey:generateSecretKey()}
const messages=[{role:'user' as const,content:'SYNTHETIC_PROMPT'}]
const ok=()=>new Response(JSON.stringify({choices:[{message:{content:'SYNTHETIC_OK'}}]}))
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})
it('direct first; network rejection proxies with body-bound member signature and own credentials',async()=>{
 const fetch=vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok());vi.stubGlobal('fetch',fetch)
 expect(await createPersonalClient(config,gateway).complete(messages)).toBe('SYNTHETIC_OK')
 expect(fetch.mock.calls[0][0]).toBe(config.baseUrl+'/chat/completions')
 const [url,init]=fetch.mock.calls[1];expect(url).toBe(gateway.baseUrl+'/proxy');expect(init.headers.authorization).toMatch(/^Nostr /)
 expect(JSON.parse(init.body)).toEqual({url:config.baseUrl+'/chat/completions',apiKey:config.apiKey,body:JSON.stringify({messages,stream:false,model:config.model})})
})
it('test connection never succeeds using house fallback; errors are plain Chinese and body-free',async()=>{
 for(const status of [401,402,500]){const fetch=vi.fn(async()=>new Response('SYNTHETIC_SECRET',{status}));vi.stubGlobal('fetch',fetch);let error;try{await testConnection(config,gateway)}catch(e){error=e};expect(connectionError(error)).not.toMatch(/SYNTHETIC|HTTP|Error/);expect(fetch).toHaveBeenCalledTimes(1)}
 expect(connectionError({})).toContain('网络')
})
it('own failure tries house only during use; disabled house returns failure for caller fixed questions',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(new Response('',{status:402})).mockResolvedValueOnce(ok());vi.stubGlobal('fetch',fetch)
 const notice=vi.fn();expect(await createPersonalClient(config,gateway,notice).complete(messages)).toBe('SYNTHETIC_OK');expect(fetch.mock.calls[1][0]).toBe(gateway.baseUrl+'/chat/completions');expect(notice).toHaveBeenCalledWith(true)
 fetch.mockReset().mockResolvedValueOnce(new Response('',{status:402})).mockResolvedValueOnce(new Response('',{status:503}));await expect(createPersonalClient(config,gateway).complete(messages)).rejects.toThrow()
})
it('stream does not append a different model after partial output',async()=>{
 const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ONE"}}]}\n\n'));setTimeout(()=>c.error(Error('closed')),1)}})
 const fetch=vi.fn(async()=>new Response(body));vi.stubGlobal('fetch',fetch);const tokens:string[]=[]
 await expect(createPersonalClient(config,gateway).stream(messages,t=>tokens.push(t))).rejects.toThrow();expect(tokens).toEqual(['ONE']);expect(fetch).toHaveBeenCalledTimes(1)
})

it('own timeout reaches house and aborts actual fetch signal, with no proxy retry for timeout',async()=>{
 const fetch=vi.fn().mockImplementationOnce(async(_url:string,init:RequestInit)=>new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(init.signal!.reason)))).mockResolvedValueOnce(ok());vi.stubGlobal('fetch',fetch)
 expect(await createPersonalClient(config,gateway,undefined,10).complete(messages)).toBe('SYNTHETIC_OK');expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[1][0]).toBe(gateway.baseUrl+'/chat/completions')
})
it('invalid addresses and malformed credentials are rejected before sending',async()=>{
 const {normalizeModel}=await import('./personal')
 for(const baseUrl of ['http://localhost/v1','https://name:pass@example.com/v1','https://example.com/v1?token=bad'])expect(()=>normalizeModel({...config,baseUrl})).toThrow()
 expect(()=>normalizeModel({...config,apiKey:'bad\r\nheader'})).toThrow()
})
