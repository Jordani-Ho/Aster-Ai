import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
export const root = fileURLToPath(new URL('../', import.meta.url))
export function command(executable, args, { cwd = root, env = process.env, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'] })
    let output = '', error = ''
    child.stdout.on('data', data => { output += data })
    child.stderr?.on('data', data => { error = (error + data).slice(-12000) })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(output.trim()) : reject(Error(`${executable} exited ${code}${error ? ': ' + error : ''}`)))
  })
}
export async function stopChild(child, gracefulInput = false) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'exit').catch(() => {})
  if (!gracefulInput) child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 5000)
  force.unref()
  try { await closed } finally { clearTimeout(force) }
}
export async function linuxPath(input) {
  return process.platform === 'win32' ? command('wsl.exe', ['-d', 'Ubuntu', '--exec', 'wslpath', '-a', input], { quiet: true }) : input
}
