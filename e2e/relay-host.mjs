// Always use this supervisor (also under WSL): EOF on the control pipe tears down the real relay.
import { spawn } from 'node:child_process'
const [binary, config, database] = process.argv.slice(2)
if (!binary || !config || !database) throw Error('relay-host requires binary, config, database')
const child = spawn(binary, ['--config', config, '--db', database], { env: { ...process.env, RUST_LOG: 'off' }, stdio: 'ignore' })
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true; child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 4000); force.unref()
}
process.stdin.resume()
process.stdin.on('data', stop); process.stdin.on('end', stop)
process.on('SIGTERM', stop); process.on('SIGINT', stop)
child.on('error', () => { process.exitCode = 1; process.stdin.destroy() })
child.on('exit', code => { process.exitCode = stopping ? 0 : code ?? 1; process.stdin.destroy() })
