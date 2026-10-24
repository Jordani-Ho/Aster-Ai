#!/usr/bin/env bash
# 第二版内测验收探测：./verify.sh
# 检查六项：应用页面 200、网关无凭据 401、网关非成员 403、网关成员 202、
#          中继成员 AUTH 通过、中继开放模式接受任意已认证身份；另做日志隐私扫描与数据目录检查。
# 只读探测（唯一的本地写入是验收用自测成员密钥 data/self-member.json）；用后即走。
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
FAIL=0
step() { printf '\n== %s ==\n' "$*"; }

set -a
[ -f .env ] || die "缺少 .env"
# shellcheck disable=SC1091
. ./.env
set +a
APP_DOMAIN="${APP_DOMAIN:-}"
RELAY_DOMAIN="${RELAY_DOMAIN:-}"
[ -n "$APP_DOMAIN" ] || die "APP_DOMAIN 为空：先运行 ./quick-start.sh。"
[ -n "$RELAY_DOMAIN" ] || die "RELAY_DOMAIN 为空：先运行 ./quick-start.sh。"
command -v node >/dev/null 2>&1 || die "缺少 node（setup.sh 也要求 Node 22）。"

APP_URL="https://${APP_DOMAIN}"
RELAY_WS="wss://${RELAY_DOMAIN}/"
SELF_MEMBER_FILE="data/self-member.json"
mkdir -p data

# 验收用自测成员：只为探测“成员请求 202 / 成员 AUTH”，不是成员白名单、也不写中继配置。
# 生成一次后存在 data/self-member.json 复用；公钥加入网关成员名单（网关每次请求都重读该文件）。
ensure_self_member() {
  if [ -f "$SELF_MEMBER_FILE" ]; then
    MEMBER_SECRET="$(node -p "JSON.parse(require('fs').readFileSync('$SELF_MEMBER_FILE','utf8')).secret")"
    MEMBER_PUBKEY="$(node -p "JSON.parse(require('fs').readFileSync('$SELF_MEMBER_FILE','utf8')).pubkey")"
  else
    log "生成验收用自测成员（只用于探测，不加入中继白名单）…"
    local out
    out="$(docker compose run --rm --no-deps -T gateway node --input-type=module -e "import {generateSecretKey,getPublicKey} from 'nostr-tools/pure'; const sk=generateSecretKey(); console.log(Array.from(sk,b=>b.toString(16).padStart(2,'0')).join('')); console.log(getPublicKey(sk))")"
    MEMBER_SECRET="$(printf '%s\n' "$out" | sed -n '1p')"
    MEMBER_PUBKEY="$(printf '%s\n' "$out" | sed -n '2p')"
    { [ ${#MEMBER_SECRET} -eq 64 ] && [ ${#MEMBER_PUBKEY} -eq 64 ]; } || die "自测成员密钥生成失败，输出：$out"
    SECRET="$MEMBER_SECRET" PUBKEY="$MEMBER_PUBKEY" node --input-type=module <<'NODE'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
const file='data/self-member.json'
writeFileSync(file, JSON.stringify({secret: process.env.SECRET, pubkey: process.env.PUBKEY}), {mode:0o600})
mkdirSync('data/gateway',{recursive:true})
const membersFile='data/gateway/members.json'
let members=[]
try{members=JSON.parse(readFileSync(membersFile,'utf8'));if(!Array.isArray(members))members=[]}catch{}
if(!members.includes(process.env.PUBKEY))members.push(process.env.PUBKEY)
writeFileSync(membersFile, JSON.stringify(members), {mode:0o600})
NODE
  fi
}

ensure_self_member

step "1/5 网络探测（应用 / 中继 / 网关）"
PROFILE="domain"
RUNNING="$(docker ps --format '{{.Label "com.docker.compose.service"}}' 2>/dev/null || true)"
if printf '%s\n' "$RUNNING" | grep -qx 'cloudflared-app'; then PROFILE="quick"; fi
log "当前模式：$PROFILE"
docker compose --profile "$PROFILE" run --rm --no-deps -T \
  -v "$(pwd)/verify.mjs:/app/verify.mjs:ro" \
  -e "APP_URL=$APP_URL" \
  -e "RELAY_WS=$RELAY_WS" \
  -e "MEMBER_SECRET=$MEMBER_SECRET" \
  -e "MEMBER_PUBKEY=$MEMBER_PUBKEY" \
  gateway node /app/verify.mjs || FAIL=1

step "2/5 数据目录与配置"
if [ -d data/relay ] && [ -n "$(find data/relay -type f -print -quit)" ]; then
  log "PASS relay 数据目录非空：$(find data/relay -type f | wc -l) 个文件"
else
  log "WARN relay 数据目录还是空的（刚启动、还没有事件时正常）"
fi
for file in data/relay-config.toml data/gateway-config.json data/gateway/seed.json; do
  if [ -f "$file" ]; then log "PASS 配置文件在位：$file"; else log "FAIL 缺少 $file"; FAIL=1; fi
done
# V2-31：口令文件在时必须与种子一致；老师登记后它会被自动删掉，所以不是必须存在。
if [ -f data/setup/teacher-setup-code.txt ]; then log "PASS 待用口令文件在位：data/setup/teacher-setup-code.txt"; fi
if node scripts/safeguard-data.mjs verify >/dev/null 2>&1; then
  log "PASS 口令与网关种子一致（或已登记、口令已作废）"
else
  node scripts/safeguard-data.mjs verify || true
  log "FAIL 口令与网关种子核对失败"
  FAIL=1
fi

step "3/5 docker compose logs 隐私扫描（relay / gateway / web）"
LOG_FILE="data/verify-logs.txt"
docker compose --profile "$PROFILE" logs --no-color relay gateway web > "$LOG_FILE" 2>&1 || true
if grep -q "ASTER_VERIFY_MARKER_9f3a" "$LOG_FILE"; then
  log "FAIL 日志里出现了请求正文标记"; FAIL=1
else
  log "PASS 日志里没有请求正文标记"
fi
if grep -q "$MEMBER_PUBKEY" "$LOG_FILE"; then
  log "FAIL 日志里出现了完整公钥"; FAIL=1
else
  log "PASS 日志里没有完整公钥"
fi
if grep -Eqq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$LOG_FILE"; then
  log "FAIL 日志里出现了 IP 地址"; FAIL=1
else
  log "PASS 日志里没有 IP 地址"
fi
log "（日志原文保留在 $LOG_FILE，可人工再看一遍；无域名模式下 cloudflared 的隧道日志不在扫描范围，只有隧道地址与连接状态。）"

step "4/5 容器状态"
docker compose --profile "$PROFILE" ps || true

step "5/5 结论"
if [ "$FAIL" = "0" ]; then
  log "全部通过。"
  log "手机直接打开：$APP_URL"
else
  log "有失败项，看上面的 FAIL 行。"
  exit 1
fi
