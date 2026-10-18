import { it, expect } from 'vitest'
import { createIdentity } from '../identity'
import { makeInvite, readInviteLink, inviteLink, validateInvite } from './index'
const teacher=createIdentity()
const url='https://gw.example/invite/redeem',now=1800000000
it('signed reusable invitations bind endpoint, expire in seven days and use a URL fragment',()=>{
 const event=makeInvite(teacher,url,now),link=inviteLink('https://app.example/',event)
 expect(event.created_at).toBe(now);expect(validateInvite(event,url,now)).toBe(true)
 expect(readInviteLink(link)?.pubkey).toBe(teacher.publicKey)
 expect(new URL(link).search).toBe('');expect(validateInvite(event,url,now+7*86400)).toBe(false)
 expect(validateInvite(event,'https://other.example/invite/redeem',now)).toBe(false)
})
it('rejects cached-verification mutations, duplicate tags and malformed links',()=>{
 const event=makeInvite(teacher,url,now)
 expect(validateInvite({...event,sig:'0'.repeat(128)},url,now)).toBe(false)
 expect(validateInvite({...event,tags:[...event.tags,['expiration','9999999999']]},url,now)).toBe(false)
 expect(()=>readInviteLink('https://app.example/#invite=broken')).toThrow()
 expect(readInviteLink('https://app.example/')).toBe(null)
})
