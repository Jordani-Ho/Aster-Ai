// V2-18：社区是公共场所，只有提醒的责任，不判断急症或心理状况。
// 问诊三步顶端都显示这一句；文案只在这里维护，不能关、不拦截发送。
export const CARE_REMINDER = '急症请立即去医院或拨打当地急救电话，别等老师回复。'

export function CareReminder() {
  return <p className="cf-firstaid">{CARE_REMINDER}</p>
}
