#!/usr/bin/env bash
# 更新内测环境（V2-28）：备份数据 → 重新生成配置 → 重建/重启 → 核对名单与口令没变。
# 用法：cd deploy/home && ./update.sh
#   先更新代码（在仓库根目录 git pull --ff-only），再回这里跑本脚本。
# 可选环境变量：
#   SKIP_BUILD=1  不重建镜像（只重启容器；网页会在容器启动时按当前代码重建）
#   NO_VERIFY=1   不跑 verify.sh（默认更新后跑一次验收探测）
# 关键点：成员名单 data/gateway/members.json、一次性口令 data/gateway/seed.json 与
#   data/setup/teacher-setup-code.txt 由 scripts/safeguard-data.mjs 成对处理；更新后再核对没变。
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "缺少 .env（第一次部署请先 cp .env.example .env）。"
command -v docker >/dev/null 2>&1 || die "未找到 docker。"
command -v node >/dev/null 2>&1 || die "缺少 node（setup.sh 也要求 Node 22）。"

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

# 4) 验收探测（只读；不想跑就 NO_VERIFY=1）。
#    V2-31：verify.sh 会幂等把验收自测成员补进成员名单（名单被重置过也自愈）。
if [ "${NO_VERIFY:-0}" != "1" ]; then
  log "跑一次验收探测 verify.sh…"
  ./verify.sh || printf '提醒：验收探测没有全过，看上面的 FAIL 行；环境已经更新完。\n' >&2
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
