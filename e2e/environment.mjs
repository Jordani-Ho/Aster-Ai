import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { actors } from './actors.mjs'
import { startGatewayFixture, listen, closeServer } from './gateway-fixture.mjs'
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
    const originalConfig=await (await import('node:fs/promises')).readFile(config,'utf8')
    const host = path.join(root, 'e2e/relay-host.mjs')
    let relay, currentDatabase = database
    const stopRelay = async () => {
      if (relay) { if (relay.exitCode === null && relay.signalCode === null) relay.stdin.end('stop\n'); await stopChild(relay, true); relay = null }
    }
    const bootRelay = async () => {
      const args = [build.binary, await linuxPath(config), await linuxPath(currentDatabase)]
      const child = process.platform === 'win32'
        ? spawn('wsl.exe', ['-d', 'Ubuntu', '--exec', 'node', await linuxPath(host), ...args], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
        : spawn(process.execPath, [host, ...args], { stdio: ['pipe', 'ignore', 'ignore'] })
      await once(child, 'spawn'); child.stdin.on('error', () => {}); relay = child
      await ready('http://127.0.0.1:' + relayPort + '/', child)
    }
    closers.push(stopRelay)
    await bootRelay()
    const resetToken = crypto.randomUUID()
    let resetting = false
    const control = httpServer(async (req, res) => {
      if (req.url !== '/reset' || req.method !== 'POST' || req.headers.authorization !== 'Bearer ' + resetToken) { res.writeHead(403).end(); return }
      if (resetting) { res.writeHead(409).end(); return }
      resetting = true
      try {
        let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw Error('control body too large')}
        const options=body?JSON.parse(body):{}
        let configText=originalConfig.replace('[authorization]','[authorization]\ncommunity_open = '+(options.communityOpen!==false))
        if(Array.isArray(options.members))configText=configText.replace(/pubkey_whitelist = .*/, 'pubkey_whitelist = '+JSON.stringify(options.members))
        await writeFile(config,configText)
        if(!options.relayOnly)await gateway.resetMembers()
        await stopRelay(); await rm(currentDatabase, { recursive: true, force: true })
        currentDatabase = await mkdtemp(path.join(directory, 'database-'))
        await bootRelay(); res.writeHead(200).end('{}')
      } catch { res.writeHead(500).end('{}') } finally { resetting = false }
    })
    const controlURL = await listen(control)
    closers.push(() => closeServer(control))
    const gateway = await startGatewayFixture({ directory, members: [] })
    closers.push(() => gateway.close())
    const app = await startWebApp({ gatewayUrl: gateway.url, relayUrl })
    closers.push(() => app.close())
    const baseURL = app.url
    const runtime = { baseURL, relayUrl, controlURL, resetToken, gatewayUrl: gateway.url, build: { cached: build.cached, elapsedMs: build.elapsedMs, key: build.key }, phase: 'consultation-and-pilot' }
    const runtimeFile = path.join(directory, 'runtime.json'); await writeFile(runtimeFile, JSON.stringify(runtime))
    return { ...runtime, runtimeFile, close }
  } catch (error) { await close(); throw error }
}

export async function startWebApp({ gatewayUrl, relayUrl }) {
  const requireApp = createRequire(new URL('../app/package.json', import.meta.url))
  const { createServer: createVite } = await import(pathToFileURL(requireApp.resolve('vite')).href)
  const { default: react } = await import(pathToFileURL(requireApp.resolve('@vitejs/plugin-react')).href)
  const webPort = await port()
  const app = await createVite({ configFile: false, root: path.join(root, 'app'), plugins: [react()],
    define: { 'import.meta.env.VITE_COMMUNITY_RELAYS': JSON.stringify(relayUrl), 'import.meta.env.VITE_MODEL_GATEWAY_URL': JSON.stringify('http://127.0.0.1:' + webPort + '/v1') },
    resolve: { dedupe: ['lunar-typescript', 'timezonecomplete', 'tzdata'] },
    server: { host: '127.0.0.1', port: webPort, strictPort: true, fs: { allow: [root] }, proxy: { '/v1': { target: gatewayUrl, changeOrigin: false }, '/push': { target: gatewayUrl, changeOrigin: false }, '/invite': { target: gatewayUrl, changeOrigin: false } } },
  })
  try { await app.listen() } catch (error) { await app.close(); throw error }
  return { url: `http://127.0.0.1:${app.httpServer.address().port}`, close: () => app.close() }
}
