#!/usr/bin/env bash
# 更新内测环境（V2-28）：备份数据 → 重新生成配置 → 重建/重启 → 核对名单与口令没变。
# 用法：cd deploy/home && ./update.sh
#   先更新代码（在仓库根目录 git pull --ff-only），再回这里跑本脚本。
# 可选环境变量：
#   SKIP_BUILD=1  不重建镜像（只重启容器；网页会在容器启动时按当前代码重建）
#   NO_VERIFY=1   不跑 verify.sh（默认更新后跑一次验收探测）
#   READY_INTERVAL / READY_TIMEOUT  等网页就绪的探测间隔与上限（默认 5 秒 / 180 秒；主要给测试用）
# 关键点：成员名单 data/gateway/members.json、一次性口令 data/gateway/seed.json 与
#   data/setup/teacher-setup-code.txt 由 scripts/safeguard-data.mjs 成对处理；更新后再核对没变。
#   web 容器启动时还要在容器里重新构建前端，重建后立刻探测会拿到 502：先等页面就绪再验收。
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "缺少 .env（第一次部署请先 cp .env.example .env）。"
command -v docker >/dev/null 2>&1 || die "未找到 docker。"
command -v node >/dev/null 2>&1 || die "缺少 node（setup.sh 也要求 Node 22）。"
command -v curl >/dev/null 2>&1 || die "缺少 curl（部署脚本用它探测网页是否就绪）：sudo apt-get install -y curl"
APP_DOMAIN="$(sed -n 's/^APP_DOMAIN=//p' .env | tail -1 | tr -d '\r')"

hash_of() {
  node -e "try{process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1],'utf8')).digest('hex'))}catch{process.stdout.write('')}" "$1"
}
count_members() {
  node -e "try{const m=JSON.parse(require('fs').readFileSync('data/gateway/members.json','utf8'));process.stdout.write(String(Array.isArray(m)?m.length:Array.isArray(m?.members)?m.members.length:0))}catch{process.stdout.write('0')}"
}

# 1) 备份成员名单与一次性口令；被删了就先用上次备份恢复。
node scripts/safeguard-data.mjs prepare || die "部署数据备份/恢复失败"
before_members="$(count_members)"
before_seed="$(hash_of data/gateway/seed.json)"
before_code="$(hash_of data/setup/teacher-setup-code.txt)"
log "更新前：成员名单 ${before_members} 人"

# 2) 重新生成配置（不删数据；setup.sh 里也会再备份一次）。
SKIP_BUILD="${SKIP_BUILD:-0}" ./setup.sh

# 3) 判断当前跑的是临时隧道还是固定域名；重建后端与网页。
RUNNING="$(docker ps --format '{{.Label "com.docker.compose.service"}}' 2>/dev/null || true)"
PROFILE="quick"
if printf '%s\n' "$RUNNING" | grep -qx 'cloudflared'; then PROFILE="domain"; fi
log "当前模式：$PROFILE"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "重建镜像（relay / gateway / web）…"
  docker compose --profile "$PROFILE" build relay gateway web
fi
log "重启容器（force-recreate relay / gateway / web）…"
docker compose --profile "$PROFILE" up -d --force-recreate relay gateway web
if [ "$PROFILE" = "domain" ]; then
  docker compose --profile domain up -d
else
  log "临时隧道的 cloudflared 容器没有重建，网址保持不变。"
fi

# 4) 等网页、网关、中继就绪，再做验收探测（只读；不想跑就 NO_VERIFY=1）。
#    web 容器每次启动都要在容器里重新构建前端，重建后立刻探测会拿到 502；
#    这里每 5 秒探一次应用首页，最多等 3 分钟，超时才报失败并提示稍后单独跑 verify.sh。
#    V2-31：verify.sh 会幂等把验收自测成员补进成员名单（名单被重置过也自愈）。
ready_failed=0
if [ "${NO_VERIFY:-0}" != "1" ]; then
  if [ -z "$APP_DOMAIN" ] || [ "${APP_DOMAIN:-placeholder.invalid}" = "placeholder.invalid" ]; then
    log "提醒：.env 里还没有可用的 APP_DOMAIN，跳过就绪等待，直接跑 verify.sh。"
    ./verify.sh || printf '提醒：验收探测没有全过，看上面的 FAIL 行；环境已经更新完。\n' >&2
  else
    READY_INTERVAL="${READY_INTERVAL:-5}"
    READY_TIMEOUT="${READY_TIMEOUT:-180}"
    APP_URL="https://${APP_DOMAIN}"
    log "等网页、网关、中继就绪（每 ${READY_INTERVAL} 秒探测 $APP_URL，最多 ${READY_TIMEOUT} 秒）…"
    ready=0
    waited=0
    while :; do
      if curl -fsS --max-time 5 "$APP_URL/" >/dev/null 2>&1; then ready=1; break; fi
      if [ "$waited" -ge "$READY_TIMEOUT" ]; then break; fi
      sleep "$READY_INTERVAL"
      waited=$((waited + READY_INTERVAL))
    done
    if [ "$ready" = "1" ]; then
      log "网页已就绪（约等了 ${waited} 秒），跑一次验收探测 verify.sh…"
      ./verify.sh || printf '提醒：验收探测没有全过，看上面的 FAIL 行；环境已经更新完。\n' >&2
    else
      ready_failed=1
      printf '错误：网页 %s 秒还没就绪（每 %s 秒探测一次）。构建还没完成，稍后单独跑 ./verify.sh 再验收。\n' "$READY_TIMEOUT" "$READY_INTERVAL" >&2
    fi
  fi
fi

# 5) 核对：名单人数不能变少、一次性口令种子不能变；不对就恢复并停下。
#    顺序说明：名单恢复只在第 1 步 prepare 里做（setup 之前），这里只核对；
#    所以 verify 刚补进去的自测成员只会让人数变多，不会被这里的恢复覆盖掉。
node scripts/safeguard-data.mjs check "$before_members" "$before_seed" "$before_code" || die "更新后核对失败：看上面的提醒，名单/口令已尽量从备份恢复。"

after_members="$(count_members)"
log ""
log "更新完成："
log "  成员名单：${after_members} 人（更新前 ${before_members} 人）"
log "  一次性登记口令没有变（旧邀请仍然有效）"
log "  备份目录：data/backup/last（只在本机，确认无误后可删）"

if [ "$ready_failed" = "1" ]; then
  printf '失败：构建还没完成，稍后单独跑 ./verify.sh 再验收。\n' >&2
  exit 1
fi
