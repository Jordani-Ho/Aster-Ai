import { getContact } from './core/redflags'
import type { RedFlagResult } from './core/redflags'

interface RedFlagAlertProps {
  result: RedFlagResult
  region: string | null
}

// M1-19 新规则：急症只在对话里内联提示“请尽快去医院”，不显示任何电话号码，不拦截发送；
// 唯一例外是自伤/轻生类，只显示心理援助热线（不给急救号码）。M1-04 规则引擎本身不变。
export function RedFlagAlert({ result, region }: RedFlagAlertProps) {
  const crisis = result.actions.includes('crisis')
  const hotline = crisis ? getContact(region, 'crisis') : null
  return (
    <div role="alert" className="redflag-notice">
      {crisis ? (
        <>
          <p>你并不孤单。如果现在就处于危险中，请立即联系专业援助。</p>
          {hotline
            ? <p className="redflag-hotline"><strong>{hotline.number}</strong>{hotline.name ? ' · ' + hotline.name : ''}</p>
            : <p className="redflag-hotline">请拨打当地心理援助热线，或让可信任的人陪着你。</p>}
        </>
      ) : (
        <p>您说的情况需要尽快去医院，请不要耽误。</p>
      )}
    </div>
  )
}
