import { appVersion } from './version'

// V2-29：学生端“我 → 设置”与老师端“我的馆 → 设置”最下面各显示一行小字版本号。
// 两端读同一个构建时注入值，方便发起人实测截图时看出跑的是哪个版本。
export function VersionLine() {
  return <p className="nl-quiet" data-testid="app-version" style={{ fontSize: 12, color: '#8a8f88', textAlign: 'center', padding: '18px 0 6px' }}>版本 {appVersion()}</p>
}
