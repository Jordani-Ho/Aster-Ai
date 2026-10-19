// 第二版内测验收探测（由 verify.sh 在 gateway 容器里运行，容器里有 nostr-tools）。
// 只发合成请求，不含真实资料；不打印任何请求正文、公钥全文或密钥。
// 检查六项：应用页面 200、网关无凭据 401、网关非成员 403、网关成员 202、
//          中继成员 AUTH 通过、中继开放模式接受任意已认证身份。
import { createHash } from 'node:crypto'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const APP_URL = required('APP_URL').replace(/\/$/, '')
const RELAY_WS = required('RELAY_WS')
const MEMBER_SECRET_HEX = required('MEMBER_SECRET')
const MEMBER_PUBKEY = process.env.MEMBER_PUBKEY || ''
const MARKER = 'ASTER_VERIFY_MARKER_9f3a'
let failed = false

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error('缺少环境变量 ' + name)
  return value
}
const pass = message => console.log('PASS ' + message)
const fail = message => { console.log('FAIL ' + message); failed = true }

function hexSecret(hex) {
  return Uint8Array.from(hex.match(/../g).map(pair => parseInt(pair, 16)))
}

function nip98(secret, url, body) {
  const payload = createHash('sha256').update(body).digest('hex')
  const event = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', 'POST'], ['payload', payload]],
    content: '',
  }, secret)
  return 'Nostr ' + Buffer.from(JSON.stringify(event)).toString('base64')
}

async function post(path, body, secret) {
  const url = APP_URL + path
  const headers = { 'content-type': 'application/json' }
  if (secret) headers.authorization = nip98(secret, url, body)
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) })
  return response.status
}

// 中继 NIP-42：回 AUTH 挑战，看 OK 是真还是假。
function relayAuth(secret) {
  return new Promise(resolve => {
    let settled = false, authId = ''
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* ignore */ }
      resolve(result)
    }
    const timer = setTimeout(() => finish('timeout'), 15000)
    const socket = new WebSocket(RELAY_WS)
    socket.onerror = () => finish('error')
    socket.onclose = () => finish('closed')
    socket.onmessage = event => {
      let frame
      try { frame = JSON.parse(String(event.data)) } catch { return }
      if (!Array.isArray(frame)) return
      if (frame[0] === 'AUTH' && typeof frame[1] === 'string') {
        const auth = finalizeEvent({
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['relay', RELAY_WS], ['challenge', frame[1]]],
          content: '',
        }, secret)
        authId = auth.id
        socket.send(JSON.stringify(['AUTH', auth]))
        return
      }
      if (frame[0] === 'OK' && frame[1] === authId) finish(frame[2] === true ? 'ok' : 'rejected')
      else if (frame[0] === 'CLOSED') finish('closed')
    }
  })
}

async function main() {
  // 1. 应用页面
  try {
    const response = await fetch(APP_URL + '/', { signal: AbortSignal.timeout(15000) })
    const html = await response.text()
    if (response.status === 200 && html.includes('id="root"')) pass('应用页面可打开（200）')
    else fail('应用页面异常：状态 ' + response.status)
  } catch (error) {
    fail('应用页面打不开：' + (error instanceof Error ? error.message : 'unknown'))
  }

  // 2. 网关鉴权：无凭据 401、非成员 403、成员推送 202
  try {
    const unauth = await post('/v1/chat/completions', JSON.stringify({ marker: MARKER, messages: [] }))
    if (unauth === 401) pass('网关无凭据返回 401')
    else fail('网关无凭据期望 401，实际 ' + unauth)
  } catch (error) { fail('网关无凭据请求失败：' + error) }

  try {
    const outsider = generateSecretKey()
    const status = await post('/v1/chat/completions', JSON.stringify({ marker: MARKER, messages: [] }), outsider)
    if (status === 403) pass('网关拒绝非成员（403）')
    else fail('网关非成员期望 403，实际 ' + status)
  } catch (error) { fail('网关非成员请求失败：' + error) }

  let member
  try {
    member = hexSecret(MEMBER_SECRET_HEX)
    const pubkey = MEMBER_PUBKEY || getPublicKey(member)
    const status = await post('/push/notify', JSON.stringify({ pubkey, marker: MARKER }), member)
    if (status === 202) pass('网关接受成员请求并经隧道返回 202（推送路由，无订阅也 202）')
    else fail('网关成员请求期望 202，实际 ' + status)
  } catch (error) { fail('网关成员请求失败：' + error) }

  // 3. 中继：成员 AUTH 通过、开放模式接受任意已认证身份
  if (member) {
    try {
      const result = await relayAuth(member)
      if (result === 'ok') pass('中继接受成员 AUTH')
      else fail('中继成员 AUTH 期望通过，实际 ' + result)
    } catch (error) { fail('中继成员探测失败：' + error) }
  }
  try {
    const result = await relayAuth(generateSecretKey())
    if (result === 'ok') pass('中继开放模式接受已认证的新身份')
    else fail('中继开放模式期望接受已认证连接，实际 ' + result + '（内测需要 RELAY_COMMUNITY_OPEN=true）')
  } catch (error) { fail('中继开放模式探测失败：' + error) }

  console.log(failed ? 'RESULT FAIL' : 'RESULT PASS')
  process.exit(failed ? 1 : 0)
}

void main()
