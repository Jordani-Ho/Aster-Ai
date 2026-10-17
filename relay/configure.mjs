import { writeFileSync } from 'node:fs'
const members=process.argv.slice(2)
if(!members.length||members.some(key=>!/^[0-9a-f]{64}$/.test(key)))throw Error('用法：node relay/configure.mjs <成员十六进制公钥> ...')
const url=process.env.RELAY_PUBLIC_URL??'ws://localhost:8080/'
if(!/^wss?:\/\//.test(url))throw Error('RELAY_PUBLIC_URL 必须为 ws/wss URL')
const config=`[info]
relay_url = ${JSON.stringify(url)}
name = "知衡社区开发中继"
[network]
address = "0.0.0.0"
port = 8080
[limits]
max_event_bytes = 2097152
max_ws_message_bytes = 2098176
max_ws_frame_bytes = 2098176
event_kind_allowlist = [1059]
[authorization]
nip42_auth = true
nip42_dms = true
pubkey_whitelist = ${JSON.stringify(members)}
`
writeFileSync(new URL('./config.local.toml',import.meta.url),config,'utf8')
