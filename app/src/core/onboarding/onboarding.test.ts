import { it, expect } from 'vitest'
import { createIdentity } from '../identity'
import { makeInvite, readInviteLink, inviteLink, normalizeSetupToken, validateInvite, onboardingRequest, onboardingErrorText, INVITE_ERROR, RATE_LIMIT_ERROR, CLOCK_ERROR } from './index'
const teacher=createIdentity()
const url='https://gw.example/invite/redeem',now=1800000000
it('signed reusable invitations bind endpoint, expire in seven days and use a URL fragment',()=>{
 const event=makeInvite(teacher,url,now),link=inviteLink('https://app.example/',event)
 expect(event.created_at).toBe(now);expect(validateInvite(event,url,now)).toBe(true)
 expect(readInviteLink(link)?.pubkey).toBe(teacher.publicKey)
 expect(new URL(link).search).toBe('');expect(validateInvite(event,url,now+7*86400)).toBe(false)
 expect(validateInvite(event,'https://other.example/invite/redeem',now)).toBe(false)
})
// V2-28：发起人从终端复制口令时多了一个换行/空格，网关 403。粘贴即去掉所有空白再登记。
it('粘贴的登记口令去掉前后和中间的空格、换行、制表符，其它字符原样保留',()=>{
  expect(normalizeSetupToken('  abcDEF_-123\n')).toBe('abcDEF_-123')
  expect(normalizeSetupToken('\nab\ncd\r\n\t')).toBe('abcd')
  expect(normalizeSetupToken('a b\tc')).toBe('abc')
  expect(normalizeSetupToken('')).toBe('')
  expect(normalizeSetupToken('abc')).toBe('abc')
})
it('rejects cached-verification mutations, duplicate tags and malformed links',()=>{
 const event=makeInvite(teacher,url,now)
 expect(validateInvite({...event,sig:'0'.repeat(128)},url,now)).toBe(false)
 expect(validateInvite({...event,tags:[...event.tags,['expiration','9999999999']]},url,now)).toBe(false)
 expect(()=>readInviteLink('https://app.example/#invite=broken')).toThrow()
 expect(readInviteLink('https://app.example/')).toBe(null)
})
// V2-39：429 和 401 要单独说清楚，不要和断网、5xx 混在“暂时未能加入社区”一句里。
it('邀请/登记失败时：429 说请求太频繁，401 提醒检查手机时间，其它仍是原来的兜底话',async()=>{
 const identity=createIdentity()
 const original=globalThis.fetch
 try{
  const cases:Array<{status:number;body:string;headers?:Record<string,string>;expected:string}>= [
   {status:429,body:JSON.stringify({error:'too many requests'}),headers:{'content-type':'application/json'},expected:RATE_LIMIT_ERROR},
   {status:401,body:JSON.stringify({error:'unauthorized'}),headers:{'content-type':'application/json'},expected:CLOCK_ERROR},
   {status:502,body:'bad gateway',expected:'暂时未能加入社区，请稍后重试。'},
  ]
  for(const item of cases){
   globalThis.fetch=(async()=>new Response(item.body,{status:item.status,headers:item.headers})) as typeof fetch
   await expect(onboardingRequest(identity,url,{invite:{}})).rejects.toThrow(item.expected)
  }
  expect(onboardingErrorText(new Error(RATE_LIMIT_ERROR))).toBe(RATE_LIMIT_ERROR)
  expect(onboardingErrorText(new Error(CLOCK_ERROR))).toBe(CLOCK_ERROR)
  expect(onboardingErrorText(new Error(INVITE_ERROR))).toBe(INVITE_ERROR)
  expect(onboardingErrorText(new Error('TypeError: Failed to fetch'))).toBe('暂时未能加入社区，请稍后重新打开邀请。')
 }finally{globalThis.fetch=original}
})
