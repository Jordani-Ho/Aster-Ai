#!/usr/bin/env bash
# 无域名自测：./quick-start.sh
# 用 Cloudflare 临时隧道（trycloudflare.com）跑通；地址每次重启都会变，只适合自测。
# 会做：准备镜像/密钥/占位配置 → 起临时隧道 → 读出两个临时地址 → 写回 .env →
#       重新生成中继/网关配置 → 重建 relay/gateway/web → 等页面可用。
# 注意：cloudflared 自身的重启会换临时地址，所以这里带一个“地址变了就重来”的循环。
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "缺少 curl：sudo apt-get install -y curl"

# 1) 先用占位域名把镜像、VAPID、占位配置准备好。
SKIP_BUILD="${SKIP_BUILD:-0}" ./setup.sh

# 2) 先让中继与网关起来（页面随后重建），再起两条临时隧道。
docker compose --profile quick up -d relay gateway
docker compose --profile quick up -d --no-deps cloudflared-app cloudflared-relay

extract_url() {
  local service="$1" url=""
  for _ in $(seq 1 90); do
    url="$(docker compose --profile quick logs --no-color "$service" 2>/dev/null | grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    if [ -n "$url" ]; then printf '%s' "$url"; return 0; fi
    sleep 2
  done
  return 1
}

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    KEY="$key" VALUE="$value" node -e "const fs=require('fs');const p='.env';let s=fs.readFileSync(p,'utf8');s=s.replace(new RegExp('^'+process.env.KEY+'=.*$','m'),process.env.KEY+'='+process.env.VALUE);fs.writeFileSync(p,s)"
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

wait_page() {
  local url="$1"
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 5 "$url/" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# 3) 取地址 → 写回 .env → 重新生成配置 → 重建后端。cloudflared 换地址时重试。
APP_URL=""
RELAY_URL=""
for attempt in 1 2 3; do
  log "第 ${attempt} 次读取临时隧道地址…"
  APP_URL="$(extract_url cloudflared-app)" || die "没读到应用隧道地址，查看：docker compose logs cloudflared-app"
  RELAY_URL="$(extract_url cloudflared-relay)" || die "没读到中继隧道地址，查看：docker compose logs cloudflared-relay"
  APP_HOST="${APP_URL#https://}"
  RELAY_HOST="${RELAY_URL#https://}"
  log "应用临时地址：$APP_URL"
  log "中继临时地址：${RELAY_URL/https:/wss:}"
  set_env APP_DOMAIN "$APP_HOST"
  set_env RELAY_DOMAIN "$RELAY_HOST"
  # 无域名模式下网关不单独暴露，浏览器经应用同源访问；这里只为 README/打印一致。
  set_env GATEWAY_DOMAIN "$APP_HOST"
  log "用临时地址重新生成配置…"
  SKIP_BUILD=1 ./setup.sh
  log "重建 relay / gateway / web…"
  docker compose --profile quick up -d --force-recreate relay gateway web
  log "等待网页构建与隧道回源（最多约 3 分钟）…"
  if wait_page "$APP_URL"; then
    CURRENT="$(extract_url cloudflared-app || true)"
    if [ "$CURRENT" = "$APP_URL" ]; then break; fi
    log "隧道地址在配置期间又变了（$CURRENT），重新来一次。"
  else
    log "页面还没通，若地址未变可稍后再试；先重试一次。"
  fi
  if [ "$attempt" = "3" ]; then
    die "三次都没稳定下来。看日志：docker compose --profile quick logs cloudflared-app web"
  fi
done

log ""
log "已就绪（临时地址，重启后会变；只适合自测）："
log "  应用：$APP_URL"
log "  中继：${RELAY_URL/https:/wss:}"
log "  网关：https://${APP_HOST}（页面同源访问 /v1 与 /push）"
log "验收：./verify.sh"
