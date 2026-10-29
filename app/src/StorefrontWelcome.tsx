import { inviteTitle, themeOf, type Storefront, type StorefrontEmblem } from './core/storefront'
import './storefront.css'
import './newui.css'
import './newui2.css'

// V2-09 邀请首屏（V2-17 按 09 稿重画）：标志、馆名、“某某老师邀请你”、短介绍、一个“开始使用”。
// 按卡去掉免责句：现实合规由真人把握，不写进代码。compact 用于建馆第 3 步的小预览。
export function VenueEmblem({ emblem }: { emblem: StorefrontEmblem }) {
  if (emblem === '') return null
  return <svg className="venue-emblem" viewBox="0 0 32 32" aria-hidden="true">
    {emblem === 'leaf' && <path d="M7 24c0-9 6-15 18-16 1 11-5 17-14 17-2 0-4-1-4-1z" fill="none" stroke="currentColor" strokeWidth="1.6" />}
    {emblem === 'leaf' && <path d="M8 23c4-5 8-8 13-10" fill="none" stroke="currentColor" strokeWidth="1.2" />}
    {emblem === 'sun' && <><circle cx="16" cy="16" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />{[[16,3,16,7],[16,25,16,29],[3,16,7,16],[25,16,29,16],[7,7,10,10],[22,22,25,25],[25,7,22,10],[10,22,7,25]].map((line, index) => <line key={index} x1={line[0]} y1={line[1]} x2={line[2]} y2={line[3]} stroke="currentColor" strokeWidth="1.2" />)}</>}
    {emblem === 'heart' && <path d="M16 26c-7-4-10-8-10-12a5 5 0 0 1 10-1 5 5 0 0 1 10 1c0 4-3 8-10 12z" fill="none" stroke="currentColor" strokeWidth="1.6" />}
    {emblem === 'dot' && <><circle cx="16" cy="16" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="16" cy="16" r="2" fill="currentColor" /></>}
  </svg>
}

export interface StorefrontWelcomeProps {
  storefront: Storefront | null
  /** 邀请里的老师公钥，只用来在没显示称呼时给个可读称呼。 */
  teacher: string
  onStart?: () => void
  busy?: boolean
  error?: string
  /** 老师端预览：按钮不可点，不触发加入。 */
  preview?: boolean
  /** 建馆第 3 步的小预览卡片。 */
  compact?: boolean
}

export function StorefrontWelcome({ storefront, teacher, onStart, busy = false, error = '', preview = false, compact = false }: StorefrontWelcomeProps) {
  const style = themeOf(storefront)
  if (compact) {
    return <section className="storefront-welcome sf-welcome sf-compact" aria-label="学生看到的样子" style={{ background: style.background }}>
      <div className="sf-compact-card" style={{ ['--venue-primary' as string]: style.primary }}>
        <span className="sf-emblem sf-emblem-small"><VenueEmblem emblem={storefront?.emblem ?? ''} /></span>
        <div>
          <h1 className="storefront-name">{storefront?.name || '知衡'}</h1>
          <p className="storefront-invite">{inviteTitle(storefront, teacher)}</p>
          {storefront?.intro && <p className="storefront-intro">{storefront.intro}</p>}
        </div>
      </div>
    </section>
  }
  return <main className="storefront-welcome sf-welcome" style={{ background: style.background, color: '#26221c', ['--venue-primary' as string]: style.primary }}>
    <div className="sf-body">
      <span className="sf-emblem"><VenueEmblem emblem={storefront?.emblem ?? ''} /></span>
      <p className="storefront-invite">{inviteTitle(storefront, teacher)}</p>
      <h1 className="storefront-name">{storefront?.name || '知衡'}</h1>
      {storefront?.intro && <p className="storefront-intro">{storefront.intro}</p>}
      <span className="sf-divider" aria-hidden="true" />
      <p className="sf-lines">每天照照镜子，看看自己的变化。<br />有不舒服的地方，整理好发给老师。</p>
    </div>
    <footer className="sf-foot">
      <button className="storefront-start" disabled={preview || busy} onClick={onStart}>{busy ? '正在接入…' : '开始使用'}</button>
      <p className="storefront-hint">接下来，接入你自己的模型。</p>
      {error && <p role="alert" className="storefront-error">{error}</p>}
    </footer>
  </main>
}
