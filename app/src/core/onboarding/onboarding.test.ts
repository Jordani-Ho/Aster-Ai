import { it, expect } from 'vitest'
import { createIdentity } from '../identity'
import { makeInvite, readInviteLink, inviteLink, normalizeSetupToken, validateInvite } from './index'
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
