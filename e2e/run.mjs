import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { command, root, stopChild } from './process.mjs'
import { buildRelay } from './build-relay.mjs'
// Bootstrap lockfile-pinned JS dependencies only when missing; system prerequisites are documented.
for (const [prefix, entry] of [['.', 'node_modules/@playwright/test/cli.js'], ['app', 'app/node_modules/vite/package.json'], ['gateway', 'gateway/node_modules/nostr-tools/package.json']]) {
  if (!existsSync(path.join(root, entry))) {
    if (!process.env.npm_execpath) throw Error('Run npm run e2e so the pinned dependency bootstrap can use npm')
    await command(process.execPath, [process.env.npm_execpath, 'ci', '--prefix', prefix])
  }
}
const { chromium } = await import('@playwright/test')
if (!existsSync(chromium.executablePath())) {
  await command(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'install', 'chromium'])
}
let environment, tests, interrupted = false
const stop = () => { interrupted = true; if (tests) void stopChild(tests) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  const build = await buildRelay()
  console.log(`Real relay: ${build.cached ? 'cache hit' : 'built'} in ${(build.elapsedMs / 1000).toFixed(1)}s`)
  if (interrupted) throw Error('E2E interrupted')
  const { startEnvironment } = await import('./environment.mjs')
  environment = await startEnvironment(build)
  console.log('Environment ready: real relay + real gateway + local model/push stubs; running consultation and pilot acceptance.')
  tests = spawn(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--config=e2e/playwright.config.ts', ...process.argv.slice(2)], {
    cwd: root, env: { ...process.env, E2E_RUNTIME_FILE: environment.runtimeFile }, windowsHide: true, stdio: 'inherit',
  })
  const [code] = await once(tests, 'exit')
  process.exitCode = interrupted ? 130 : code ?? 1
} catch (error) { console.error(error); process.exitCode = 1 }
finally { if (tests) await stopChild(tests); await environment?.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
