#!/usr/bin/env bash
# V2-39：正式重置老师登记。部署口令只能用一次；这个脚本把老师登记相关凭据
# “存在才移、不删”地移到 data/backup/pre-reset-<时间>/，再重新生成一对新口令。
# 不删 data/ 里的任何文件、不动成员名单、不动中继数据、不重启 cloudflared。
# 用法：cd deploy/home && ./reset-teacher-setup.sh
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "缺少 .env（第一次部署请先 cp .env.example .env）。"
command -v docker >/dev/null 2>&1 || die "未找到 docker。"
[ -d data ] || die "缺少 data 目录：这里不是已经部署过的 deploy/home。"

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="data/backup/pre-reset-$STAMP"
mkdir -p "$DEST"

# 只动老师登记相关的六份凭据；存在才移。
# 必须连 data/backup/last 里的同名文件一起移：safeguard 会从备份把“已登记”的旧种子恢复回来。
moved=0
for file in \
  data/gateway/seed.json \
  data/setup/teacher-setup-code.txt \
  data/setup/teacher-setup.html \
  data/backup/last/seed.json \
  data/backup/last/teacher-setup-code.txt \
  data/backup/last/teacher-setup.html
do
  if [ -f "$file" ]; then
    mv -v "$file" "$DEST/"
    moved=$((moved + 1))
  fi
done

if [ "$moved" -eq 0 ]; then
  die "没找到老师登记凭据（种子或口令文件），不用重置。"
fi
log "旧凭据已移到 $(pwd)/$DEST（没有删）。"

log ""
log "重新生成口令并重建 relay / gateway / web（不碰 cloudflared，网址不变）…"
NO_VERIFY=1 ./update.sh

log ""
log "跑一次验收探测…"
./verify.sh

log ""
log "重置完成："
if [ -f data/setup/teacher-setup-code.txt ]; then
  log "  新的老师登记口令：$(pwd)/data/setup/teacher-setup-code.txt"
fi
if [ -f data/setup/teacher-setup.html ]; then
  log "  新的老师登记扫码页：$(pwd)/data/setup/teacher-setup.html"
fi
log "  旧凭据备份：$(pwd)/$DEST"
log ""
log "提醒：老师要用一个干净的浏览器身份（新的浏览器，或新的浏览器配置目录）。"
log "      已经开过馆的旧身份会直接进工作台，走不到建馆。"
log "提醒：只有最新登记的那位算老师；之前那位老师发出去的进馆邀请会被拒。"
