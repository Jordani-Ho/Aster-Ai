import { describe, expect, it } from 'vitest'
import { createIdentity } from '../identity'
import { makeInvite, validateInvite } from './index'

// V2-15：第一个邀请 1 小时内有效；沿用 V2-09/M1-17 的签名邀请格式，不新增协议。
// 全部合成身份与合成地址，不连网关。
const NOW = Math.floor(new Date('2026-10-20T12:00:00.000Z').getTime() / 1000)
const URL = 'https://synthetic.invalid/invite/redeem'
const identity = createIdentity()

describe('邀请有效期', () => {
  it('1 小时参数：到期前有效，到点与过后都不可用', () => {
    const invite = makeInvite(identity, URL, NOW, 3600)
    expect(validateInvite(invite, URL, NOW)).toBe(true)
    expect(validateInvite(invite, URL, NOW + 3599)).toBe(true)
    expect(validateInvite(invite, URL, NOW + 3600)).toBe(false)
    expect(validateInvite(invite, URL, NOW + 3601)).toBe(false)
  })

  it('默认仍是 7 天，超过 7 天的邀请不被接受', () => {
    const week = makeInvite(identity, URL, NOW)
    expect(validateInvite(week, URL, NOW + 7 * 86400 - 1)).toBe(true)
    expect(validateInvite(week, URL, NOW + 7 * 86400)).toBe(false)
    expect(validateInvite(makeInvite(identity, URL, NOW, 8 * 86400), URL, NOW)).toBe(false)
  })
})
