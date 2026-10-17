// 生成网关配置与成员名单（由 setup.sh 调用，也可以单独运行）。
// 只读环境变量，不写日志、不打印密钥。
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('data', { recursive: true })

const members = String(process.env.MEMBERS_ALL ?? '')
  .split(/[\s,]+/)
  .filter(Boolean)
const seen = new Set()
for (const key of members) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('成员公钥必须是 64 位小写十六进制：' + key)
  if (seen.has(key)) throw new Error('成员公钥重复：' + key)
  seen.add(key)
}
if (seen.size === 0) throw new Error('没有成员公钥')

const appOrigin = process.env.APP_ORIGIN ?? ''
if (!/^https?:\/\//.test(appOrigin)) throw new Error('APP_ORIGIN 非法：' + appOrigin)

const config = {
  port: 8787,
  // 页面与网关同源（web 容器把 /push 与 /v1 反代到 gateway），
  // 所以 NIP-98 的 u 标签就是 https://APP_DOMAIN/... ，这里只需配置应用源。
  publicUrl: appOrigin,
  upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || 'https://api.deepseek.com',
  upstreamModel: process.env.UPSTREAM_MODEL || 'deepseek-chat',
  upstreamApiKeyEnv: 'UPSTREAM_API_KEY',
  membersFile: '/app/members.json',
  maxBodyBytes: 1048576,
  upstreamTimeoutMs: 120000,
  rateLimit: { windowMs: 60000, maxPerWindow: 20 },
  push: { subscriptionsFile: '/app/data/push-subscriptions.json' },
  // 网关只记“时间/公钥前 8 位/耗时/状态码”的指标日志；这里写到 /dev/null，日志一律不落盘。
  logFile: '/dev/null',
}

writeFileSync('data/gateway-members.json', JSON.stringify([...seen], null, 2) + '\n', { mode: 0o600 })
writeFileSync('data/gateway-config.json', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
console.log('gateway config: publicUrl=' + appOrigin + ' members=' + seen.size)
