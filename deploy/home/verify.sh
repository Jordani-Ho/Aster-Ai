#!/usr/bin/env bash
# 内测验收探测：./verify.sh
# 检查：应用页面可打开、非成员连不上中继、网关鉴权（未登录 401 / 非成员 403 / 成员 202）、
#       成员 AUTH 通过、docker compose logs 不含请求内容/公钥全文/IP、数据目录存在。
# 只读探测，不改配置；用后即走（用 gateway 镜像里的 nostr-tools 跑探测脚本）。
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
[ -n "$APP_DOMAIN" ] || die "APP_DOMAIN 为空：先运行 ./start.sh 或 ./quick-start.sh。"
[ -n "$RELAY_DOMAIN" ] || die "RELAY_DOMAIN 为空：先运行 ./start.sh 或 ./quick-start.sh。"

APP_URL="https://${APP_DOMAIN}"
RELAY_WS="wss://${RELAY_DOMAIN}/"
mkdir -p data

step "1/5 网络探测（应用 / 中继 / 网关）"
# 根据正在运行的容器判断域名模式还是临时隧道模式，用于后面 logs/ps 的 profile 参数。
PROFILE="domain"
RUNNING="$(docker ps --format '{{.Label "com.docker.compose.service"}}' 2>/dev/null || true)"
if printf '%s\n' "$RUNNING" | grep -qx 'cloudflared-app'; then PROFILE="quick"; fi
log "当前模式：$PROFILE"
docker compose --profile "$PROFILE" run --rm --no-deps -T \
  -v "$(pwd)/verify.mjs:/app/verify.mjs:ro" \
  -e "APP_URL=$APP_URL" \
  -e "RELAY_WS=$RELAY_WS" \
  -e "RELAY_COMMUNITY_OPEN=${RELAY_COMMUNITY_OPEN:-true}" \
  -e "MEMBER_SECRET=${VERIFY_MEMBER_SECRET:-}" \
  -e "MEMBER_PUBKEY=${VERIFY_MEMBER_PUBKEY:-}" \
  gateway node /app/verify.mjs || FAIL=1

step "2/5 数据目录"
if [ -d data/relay ] && [ -n "$(find data/relay -type f -print -quit)" ]; then
  log "PASS relay 数据目录非空：$(find data/relay -type f | wc -l) 个文件"
else
  log "WARN relay 数据目录还是空的（刚启动、还没有事件时正常）"
fi
if [ -f data/gateway/members.json ] && [ -f data/relay-config.toml ]; then
  log "PASS 配置文件在位：data/gateway/members.json、data/relay-config.toml"
else
  log "FAIL 配置文件缺失"; FAIL=1
fi

step "3/5 docker compose logs 隐私扫描（relay / gateway / media / web）"
LOG_FILE="data/verify-logs.txt"
docker compose --profile "$PROFILE" logs --no-color relay gateway media web > "$LOG_FILE" 2>&1 || true
if grep -q "ASTER_VERIFY_MARKER_9f3a" "$LOG_FILE"; then
  log "FAIL 日志里出现了请求正文标记"; FAIL=1
else
  log "PASS 日志里没有请求正文标记"
fi
PUBKEYS="$(printf '%s\n' "${MEMBER_PUBKEYS:-}" "${VERIFY_MEMBER_PUBKEY:-}" | tr ',' ' ' | awk 'NF')"
BAD_KEY=0
for key in $PUBKEYS; do
  if [ -n "$key" ] && grep -q "$key" "$LOG_FILE"; then log "FAIL 日志里出现了完整公钥 $key"; BAD_KEY=1; fi
done
if [ "$BAD_KEY" = "0" ]; then log "PASS 日志里没有完整公钥"; else FAIL=1; fi
if grep -Eqq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$LOG_FILE"; then
  log "FAIL 日志里出现了 IP 地址"; FAIL=1
else
  log "PASS 日志里没有 IP 地址"
fi
log "（日志原文保留在 $LOG_FILE，可人工再看一遍；无域名模式下 cloudflared 的隧道日志不在此扫描范围，只有隧道地址与连接状态。）"

step "4/5 容器状态"
docker compose --profile "$PROFILE" ps || true

step "5/5 结论"
if [ "$FAIL" = "0" ]; then
  log "全部通过。整机/WSL 重启后的数据还在测试：见 README「重启与数据持久化」。"
else
  log "有失败项，看上面的 FAIL 行。"
  exit 1
fi
