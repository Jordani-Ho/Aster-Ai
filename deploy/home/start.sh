#!/usr/bin/env bash
# 域名模式启动：./start.sh
# 前提：.env 已填 APP_DOMAIN / RELAY_DOMAIN / GATEWAY_DOMAIN / CF_TUNNEL_TOKEN。
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

set -a
[ -f .env ] || die "缺少 .env，先 cp .env.example .env 并填写。"
# shellcheck disable=SC1091
. ./.env
set +a
[ -n "${APP_DOMAIN:-}" ] || die "APP_DOMAIN 为空：域名模式请先在 .env 填域名；无域名请用 ./quick-start.sh。"
[ -n "${RELAY_DOMAIN:-}" ] || die "RELAY_DOMAIN 为空：域名模式请先在 .env 填域名。"
[ -n "${CF_TUNNEL_TOKEN:-}" ] || die "CF_TUNNEL_TOKEN 为空：先在 Cloudflare Zero Trust 创建隧道并把 token 填进 .env。"

./setup.sh
log "启动域名模式容器…"
docker compose --profile domain up -d
log ""
log "容器状态："
docker compose --profile domain ps
log ""
log "对外地址（Cloudflare 里的三条 Public Hostname 应对应）："
log "  应用：https://${APP_DOMAIN}"
log "  中继：wss://${RELAY_DOMAIN}/"
log "  网关：https://${GATEWAY_DOMAIN:-$APP_DOMAIN}（浏览器实际走应用的 /v1 与 /push，同源）"
log "稍等几分钟后运行 ./verify.sh 验收。"
