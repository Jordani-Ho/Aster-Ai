import { describe, expect, it } from 'vitest'
import { createIdentity } from './identity'
import {
  makeCorePromotion, makeTeacherRecommendation, teacherRecommendationLink,
  corePromotionLink, readTeacherRecommendationLink, readCorePromotionLink,
  validateCorePromotion, validateTeacherRecommendation,
} from './teacher-invites'

const identity=createIdentity(),url='https://synthetic.invalid/invite/teacher',promotionUrl='https://synthetic.invalid/invite/core-add',now=1800000000

describe('V2-37 签名老师邀请',()=>{
  it('推荐事件签名绑定部署、理由、七天期限和首次扫码前未知的老师身份',()=>{
    const event=makeTeacherRecommendation(identity,url,'synthetic reason',now)
    expect(validateTeacherRecommendation(event,url,now)).toBe(true)
    expect(validateTeacherRecommendation(event,'https://other.invalid/invite/teacher',now)).toBe(false)
    expect(validateTeacherRecommendation(event,url,now+7*86400)).toBe(false)
    expect(validateTeacherRecommendation({...event,sig:'0'.repeat(128)},url,now)).toBe(false)
    const link=teacherRecommendationLink('https://app.synthetic.invalid/?old=1',event)
    expect(new URL(link).search).toBe('')
    expect(readTeacherRecommendationLink(link)?.id).toBe(event.id)
  })
  it('推荐理由必须是一句有效文字，不能超过上限或带控制字符',()=>{
    expect(()=>makeTeacherRecommendation(identity,url,'  ',now)).toThrow('推荐理由')
    expect(()=>makeTeacherRecommendation(identity,url,'x'.repeat(241),now)).toThrow('推荐理由')
    expect(()=>makeTeacherRecommendation(identity,url,'synthetic\nreason',now)).toThrow('推荐理由')
  })
  it('核心成员晋升事件独立签名并绑定指定网关，链接用 fragment',()=>{
    const event=makeCorePromotion(identity,promotionUrl,now)
    expect(validateCorePromotion(event,promotionUrl,now)).toBe(true)
    expect(validateCorePromotion(event,'https://other.invalid/invite/core-add',now)).toBe(false)
    const link=corePromotionLink('https://app.synthetic.invalid/',event)
    expect(readCorePromotionLink(link)?.id).toBe(event.id)
    expect(readCorePromotionLink('https://app.synthetic.invalid/')).toBeNull()
  })
})
