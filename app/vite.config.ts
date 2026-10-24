import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// V2-29：构建时写入版本号（短提交号 · 构建日期），两端设置页底部显示，排查实测问题时可对照。
// 优先级：宿主机传进来的 APP_VERSION / APP_BUILD_DATE（部署时 setup.sh 算好，经 compose 环境变量
// 传进 web 容器；镜像里没有 .git，所以部署必须走这条路）→ 本机 git rev-parse → unknown。
function today(): string {
  const now = new Date()
  return String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
}

function gitShortHash(): string {
  try {
    const directory = fileURLToPath(new URL('.', import.meta.url))
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

export function buildVersion(env: Record<string, string | undefined> = process.env): string {
  const date = (env.APP_BUILD_DATE ?? '').trim() || today()
  const hostVersion = (env.APP_VERSION ?? '').trim()
  const hash = hostVersion !== '' && hostVersion !== 'unknown' ? hostVersion : gitShortHash()
  return `${hash === '' ? 'unknown' : hash} · ${date}`
}

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['lunar-typescript', 'timezonecomplete', 'tzdata'] },
  server: { fs: { allow: ['..'] } },
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
  test: { environment: 'node' },
})
