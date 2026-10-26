import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey, verifyEvent } from 'nostr-tools/pure'
import { createPushClient, needsInstallHint, syncWhenOpen } from './index'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('订阅经 SW/VAPID，通知只带收件公钥，注销移除服务端与浏览器订阅', async () => {
 const unsubscribe = vi.fn(async()=>true)
 const subscription = { toJSON: () => ({endpoint:'https://fcm.googleapis.com/synthetic',keys:{auth:'synthetic',p256dh:'synthetic'}}), unsubscribe }
 const subscribe = vi.fn(async()=>subscription)
 const registration = { pushManager: { getSubscription: async()=>null, subscribe } }
 const register = vi.fn(async()=>registration)
 vi.stubGlobal('navigator',{serviceWorker:{register,ready:Promise.resolve(registration),getRegistration:async()=>registration}})
 vi.stubGlobal('Notification',{requestPermission:async()=> 'granted'})
 const fetcher = vi.fn(async()=>new Response('{}',{status:200}))
 vi.stubGlobal('fetch',fetcher)
 const client=createPushClient({gatewayUrl:'https://gateway.example',secretKey:generateSecretKey(),vapidPublicKey:'BAAA'})
 await client.subscribe()
 await client.notifyRecipient('a'.repeat(64))
 // 删除时重新读取当前浏览器订阅
 registration.pushManager.getSubscription = async()=>subscription as never
 await client.unsubscribe()
 expect(register).toHaveBeenCalledWith('/sw.js')
 expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({userVisibleOnly:true}))
 expect(unsubscribe).toHaveBeenCalled()
 expect(fetcher).toHaveBeenCalledTimes(3)
 for(const [url, init] of fetcher.mock.calls as unknown as [string,RequestInit][]) {
 const event=JSON.parse(atob(String((init.headers as Record<string,string>).authorization).slice(6)))
 expect(verifyEvent(event)).toBe(true)
 expect(Object.fromEntries(event.tags).u).toBe(url)
 }
 const body=JSON.parse(String((fetcher.mock.calls as unknown as [string,RequestInit][])[1][1].body))
 expect(body.pubkey).toBe('a'.repeat(64))
 expect(body).not.toHaveProperty('text')
})
it('不支持推送或 iOS 未安装时提示；打开及恢复可见时调用同步', async()=>{
 expect(needsInstallHint({supported:false,ios:false,standalone:false})).toBe(true)
 expect(needsInstallHint({supported:true,ios:true,standalone:false})).toBe(true)
 expect(needsInstallHint({supported:true,ios:true,standalone:true})).toBe(false)
 const target=new EventTarget(), sync=vi.fn(async()=>{})
 const dispose=syncWhenOpen(sync,target)
 await Promise.resolve()
 target.dispatchEvent(new Event('focus'))
 target.dispatchEvent(new Event('online'))
 await new Promise(resolve=>setTimeout(resolve,0))
 expect(sync).toHaveBeenCalled()
 dispose()
 const count=sync.mock.calls.length
 target.dispatchEvent(new Event('focus'))
 expect(sync).toHaveBeenCalledTimes(count)
})
it('督促只在本人已订阅时发无内容唤醒，未获通知权限不发送', async()=>{
 const pubkey='a'.repeat(64), subscription={endpoint:'https://push.synthetic.example/sub'}
 const registration={pushManager:{getSubscription:vi.fn(async()=>subscription)}}
 vi.stubGlobal('navigator',{serviceWorker:{getRegistration:vi.fn(async()=>registration)}})
 const notification={permission:'denied'}
 vi.stubGlobal('Notification',notification)
 const fetcher=vi.fn(async()=>new Response('{}',{status:200}))
 vi.stubGlobal('fetch',fetcher)
 const client=createPushClient({gatewayUrl:'https://gateway.example',secretKey:generateSecretKey(),vapidPublicKey:'BAAA'})
 expect(await client.notifySubscribedSelf(pubkey)).toBe(false)
 expect(fetcher).not.toHaveBeenCalled()
 notification.permission='granted'
 expect(await client.notifySubscribedSelf(pubkey)).toBe(true)
 expect(JSON.parse(String((fetcher.mock.calls as unknown as [string,RequestInit][])[0][1].body))).toEqual({pubkey})
 await expect(client.notifySubscribedSelf('bad')).rejects.toThrow('公钥')
})
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
it('SW忽略任意推送内容，始终显示固定文案，点击聚焦同源应用', async()=>{
 const listeners:Record<string,(event:any)=>void>={}
 const showNotification=vi.fn(async()=>{})
 const focus=vi.fn(async()=>{}),postMessage=vi.fn()
 const self={addEventListener:(name:string,fn:(event:any)=>void)=>{listeners[name]=fn},registration:{showNotification},location:{origin:'https://app.example'},clients:{matchAll:async()=>[{url:'https://app.example/',focus,postMessage}],openWindow:vi.fn()}}
 runInNewContext(readFileSync('public/sw.js','utf8'),{self,URL})
 let work:Promise<unknown>=Promise.resolve()
 listeners.push({get data(){throw Error('must not inspect payload')},waitUntil:(promise:Promise<unknown>)=>{work=promise}})
 await work
 expect(showNotification).toHaveBeenCalledWith('知衡：有新消息',expect.any(Object))
 expect(postMessage).toHaveBeenCalledWith({type:'aster:sync-requested'})
 postMessage.mockClear()
 listeners.notificationclick({notification:{close:vi.fn()},waitUntil:(promise:Promise<unknown>)=>{work=promise}})
 await work
 expect(focus).toHaveBeenCalled()
 expect(postMessage).toHaveBeenCalledWith({type:'aster:sync-requested'})
})
