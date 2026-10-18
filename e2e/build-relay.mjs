import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rename, rm, chmod } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { command, root, linuxPath } from './process.mjs'
export const UPSTREAM = 'b5c1f642e4f4c3b9c54f5d18d66f4c53642076b4'
const RUST = '1.90.0', PROTOC = '31.1'
const PROTOC_SHA256 = '96553041f1a91ea0efee963cb16f462f5985b4d65365f3907414c360044d8065'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const cache = process.platform === 'linux' && process.argv.includes('--native-cache')
  ? path.join(homedir(), '.cache/aster-e2e', sha(root).slice(0, 12)) : path.join(root, '.cache/e2e')
async function protoc() {
  try { if (process.env.E2E_PRIVATE_PROTOC === '1') throw Error('private compiler requested'); await command('protoc', ['--version'], { quiet: true }); return 'protoc' } catch { /* use pinned private fallback */ }
  if (process.arch !== 'x64') throw Error('Install protoc on this architecture; the private fallback supports Linux x64 only')
  const directory = path.join(cache, 'tools', 'protoc-' + PROTOC), binary = path.join(directory, 'bin/protoc')
  if (!existsSync(binary)) {
    await mkdir(directory, { recursive: true })
    const response = await fetch(`https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC}/protoc-${PROTOC}-linux-x86_64.zip`)
    if (!response.ok) throw Error('protoc download failed: ' + response.status)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (sha(bytes) !== PROTOC_SHA256) throw Error('protoc checksum mismatch')
    const zip = path.join(directory, 'protoc.zip')
    await writeFile(zip, bytes)
    // Python's standard library avoids an additional JS unzip dependency.
    await command('python3', ['-m', 'zipfile', '-e', zip, directory])
    await chmod(binary, 0o755)
  }
  return binary
}
export async function buildRelay(runTests = process.argv.includes('--test')) {
  if (process.platform === 'win32') {
    const script = await linuxPath(fileURLToPath(import.meta.url))
    const output = await command('wsl.exe', ['-d', 'Ubuntu', '--exec', 'node', script, '--json', '--native-cache', ...(runTests ? ['--test'] : [])])
    const result = JSON.parse(output.replace(/^\uFEFF/, ''))
    return { ...result, command: 'wsl.exe', args: ['-d', 'Ubuntu', '--exec', result.binary] }
  }
  if (process.platform !== 'linux') throw Error('Relay build requires Linux; Windows uses Ubuntu/WSL. See e2e/README.md')
  const started = Date.now(), privateRustup = path.join(root, '.cache/e2e/tools/cargo/bin/rustup')
  const rustup = existsSync(privateRustup) ? privateRustup : 'rustup'
  const env = { ...process.env, CARGO_HOME: path.join(cache, 'cargo') }
  if (existsSync(privateRustup)) env.RUSTUP_HOME = path.join(root, '.cache/e2e/tools/rustup')
  let rustVersion
  try { rustVersion = await command(rustup, ['run', RUST, 'rustc', '-vV'], { env, quiet: true }); await command('cmake', ['--version'], { quiet: true }) }
  catch { throw Error('Install Rust 1.90.0 via rustup plus C/C++ and cmake first; see e2e/README.md. No fake relay fallback is permitted.') }
  env.RUSTC = await command(rustup, ['which', '--toolchain', RUST, 'rustc'], { env, quiet: true })
  env.RUSTDOC = await command(rustup, ['which', '--toolchain', RUST, 'rustdoc'], { env, quiet: true })
  const compiler = await protoc(), protocVersion = await command(compiler, ['--version'])
  const patches = ['community-policy.patch', 'onboarding-policy.patch'].map(name => path.join(root, 'relay', name))
  const docker = await readFile(path.join(root, 'relay/Dockerfile'), 'utf8')
  if (!docker.includes(UPSTREAM) || !docker.includes('rust:' + RUST + '-') || patches.some(p => !docker.includes(path.basename(p)))) throw Error('Builder pins no longer match relay/Dockerfile')
  const fingerprint = sha(Buffer.concat([Buffer.from([UPSTREAM, rustVersion, protocVersion, process.platform, process.arch].join('\n')), await readFile(fileURLToPath(import.meta.url)), ...await Promise.all(patches.map(p => readFile(p)))]))
  const directory = path.join(cache, 'relay', fingerprint), binary = path.join(directory, 'nostr-rs-relay'), manifest = path.join(directory, 'manifest.json')
  try {
    const previous = JSON.parse(await readFile(manifest, 'utf8'))
    if (!runTests && previous.key === fingerprint && previous.sha256 === sha(await readFile(binary))) {
      console.error('relay cache hit: ' + fingerprint.slice(0, 12))
      return { binary, command: binary, args: [], cached: true, key: fingerprint, elapsedMs: Date.now() - started }
    }
  } catch { /* absent/incomplete cache is rebuilt; never trust an executable without its manifest */ }
  await mkdir(directory, { recursive: true })
  const lock = path.join(directory, 'build.lock')
  try { await mkdir(lock) } catch { throw Error('Relay build is already running (or an interrupted build left ' + lock + '); inspect before removing the lock') }
  const source = await mkdtemp(path.join(directory, 'source-'))
  try {
    console.error('Building real relay from ' + UPSTREAM + ' with all policy patches; first release build may take several minutes.')
    await command('git', ['init', '-q', source])
    await command('git', ['-C', source, 'remote', 'add', 'origin', 'https://github.com/scsibug/nostr-rs-relay.git'])
    await command('git', ['-C', source, 'fetch', '--depth', '1', 'origin', UPSTREAM])
    await command('git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD'])
    for (const patch of patches) {
      await command('git', ['-C', source, 'apply', '--check', patch])
      await command('git', ['-C', source, 'apply', patch])
    }
    const target = path.join(cache, 'target', 'rust-' + RUST)
    await command(rustup, ['run', RUST, 'cargo', 'build', '--release', '--locked'], { cwd: source, env: { ...env, PROTOC: compiler, CARGO_TARGET_DIR: target, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2' } })
    let testResults=[]
    if(runTests){const output=await command(rustup,['run',RUST,'cargo','test','--release','--locked','--','--test-threads=1'],{cwd:source,env:{...env,RUST_LOG:'off',PROTOC:compiler,CARGO_TARGET_DIR:target,CARGO_BUILD_JOBS:process.env.CARGO_BUILD_JOBS??'2'}});testResults=output.match(/^test result:.*$/gm)??[];console.error(testResults.join('\n'))}
    await copyFile(path.join(target, 'release/nostr-rs-relay'), binary + '.tmp')
    await chmod(binary + '.tmp', 0o755)
    await rename(binary + '.tmp', binary)
    await writeFile(manifest + '.tmp', JSON.stringify({ key: fingerprint, upstream: UPSTREAM, rust: RUST, protoc: protocVersion, testResults, sha256: sha(await readFile(binary)) }))
    await rename(manifest + '.tmp', manifest)
    return { binary, command: binary, args: [], cached: false, key: fingerprint, elapsedMs: Date.now() - started }
  } finally {
    // Only generated directories underneath the verified workspace cache are removed.
    await rm(source, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await buildRelay())) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
