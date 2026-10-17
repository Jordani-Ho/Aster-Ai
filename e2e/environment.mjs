import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { actors } from './actors.mjs'
import { startGatewayFixture } from './gateway-fixture.mjs'
import { root, linuxPath, stopChild } from './process.mjs'

async function port() {
  const socket = createServer()
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const selected = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return selected
}
async function ready(url, process) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) throw Error('Real relay exited during startup: ' + process.exitCode)
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error('Real relay readiness timeout')
}
export async function startEnvironment(build) {
  const cache = path.join(root, '.cache/e2e'); await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(path.join(cache, 'run-')), closers = [() => rm(directory, { recursive: true, force: true })]
  let closed = false
  const close = async () => {
    if (closed) return; closed = true
    const failures = []
    for (const finish of closers.reverse()) try { await finish() } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'E2E cleanup failed')
  }
  try {
    const relayPort = await port(), relayUrl = `ws://127.0.0.1:${relayPort}/`, database = path.join(directory, 'relay-data')
    await mkdir(database)
    const config = path.join(directory, 'relay.toml')
    await writeFile(config, `[info]\nrelay_url = "${relayUrl}"\nname = "Synthetic E2E relay"\n[network]\naddress = "127.0.0.1"\nport = ${relayPort}\n[limits]\nmax_event_bytes = 2097152\nmax_ws_message_bytes = 2098176\nmax_ws_frame_bytes = 2098176\nevent_kind_allowlist = [1059, 30078]\n[authorization]\nnip42_auth = true\nnip42_dms = true\npubkey_whitelist = ${JSON.stringify([actors.teacher.pubkey, actors.student.pubkey])}\n`)
    const host = path.join(root, 'e2e/relay-host.mjs')
    const args = [build.binary, await linuxPath(config), await linuxPath(database)]
    const relay = process.platform === 'win32'
      ? spawn('wsl.exe', ['-d', 'Ubuntu', '--exec', 'node', await linuxPath(host), ...args], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
      : spawn(process.execPath, [host, ...args], { stdio: ['pipe', 'ignore', 'ignore'] })
    await once(relay, 'spawn')
    relay.stdin.on('error', () => {})
    closers.push(async () => { if (relay.exitCode === null && relay.signalCode === null) relay.stdin.end('stop\n'); await stopChild(relay, true) })
    await ready(`http://127.0.0.1:${relayPort}/`, relay)
    const gateway = await startGatewayFixture({ directory, members: [actors.teacher.pubkey, actors.student.pubkey] })
    closers.push(() => gateway.close())
    const app = await startWebApp({ gatewayUrl: gateway.url, relayUrl })
    closers.push(() => app.close())
    const baseURL = app.url
    const runtime = { baseURL, relayUrl, gatewayUrl: gateway.url, build: { cached: build.cached, elapsedMs: build.elapsedMs, key: build.key }, phase: 'environment-only' }
    const runtimeFile = path.join(directory, 'runtime.json'); await writeFile(runtimeFile, JSON.stringify(runtime))
    return { ...runtime, runtimeFile, close }
  } catch (error) { await close(); throw error }
}

export async function startWebApp({ gatewayUrl, relayUrl }) {
  const requireApp = createRequire(new URL('../app/package.json', import.meta.url))
  const { createServer: createVite } = await import(pathToFileURL(requireApp.resolve('vite')).href)
  const { default: react } = await import(pathToFileURL(requireApp.resolve('@vitejs/plugin-react')).href)
  const app = await createVite({ configFile: false, root: path.join(root, 'app'), plugins: [react()],
    define: { 'import.meta.env.VITE_COMMUNITY_RELAYS': JSON.stringify(relayUrl) },
    resolve: { dedupe: ['lunar-typescript', 'timezonecomplete', 'tzdata'] },
    server: { host: '127.0.0.1', port: await port(), strictPort: true, fs: { allow: [root] }, proxy: { '/v1': { target: gatewayUrl, changeOrigin: false }, '/push': { target: gatewayUrl, changeOrigin: false } } },
  })
  try { await app.listen() } catch (error) { await app.close(); throw error }
  return { url: `http://127.0.0.1:${app.httpServer.address().port}`, close: () => app.close() }
}
