import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// V2-29：构建时写入版本号（git 短提交号 · 构建日期），两端设置页底部显示，排查实测问题时可对照。
// 只在构建/启动开发服务器时算一次；页面运行时不再调用 git。没有 git 的环境（例如只拿源码包）写 unknown。
function buildVersion(): string {
  let hash = 'unknown'
  try {
    const directory = fileURLToPath(new URL('.', import.meta.url))
    hash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim() || 'unknown'
  } catch { /* 保持 unknown */ }
  const now = new Date()
  const date = String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
  return `${hash} · ${date}`
}

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['lunar-typescript', 'timezonecomplete', 'tzdata'] },
  server: { fs: { allow: ['..'] } },
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
  test: { environment: 'node' },
})
