#!/usr/bin/env bash
# 知衡内测部署 · 配置生成与预检。
# 在 WSL2 里以普通用户运行：./setup.sh
# 不调用 sudo，不安装任何东西；Docker 需要先按 README 第 1 步装好。
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
warn() { printf '提醒：%s\n' "$*" >&2; }

# ---- 1. Docker 预检 ----
command -v docker >/dev/null 2>&1 || die "未找到 docker。请先按 README「第 1 步：安装 Docker」在 WSL 里安装（需要 sudo 密码，本脚本不会替你执行）。"
docker compose version >/dev/null 2>&1 || die "docker compose v2 不可用。请确认装了 docker-compose-plugin，然后重开终端。"
docker info >/dev/null 2>&1 || die "Docker 守护进程没有运行。执行：sudo systemctl start docker（或退出 WSL 重开），再重跑本脚本。"
command -v node >/dev/null 2>&1 || die "未找到 node。本脚本用 Node 22 生成配置（仓库开发也需要它）。"

# ---- 2. 读取 .env ----
[ -f .env ] || die "缺少 .env。请先执行：cp .env.example .env，再按文件里的说明填写。"
chmod 600 .env 2>/dev/null || true
set -a
# shellcheck disable=SC1091
. ./.env
set +a

normalize_members() {
  printf '%s' "${MEMBER_PUBKEYS:-}" | tr ',' ' ' | tr -s '[:space:]' '\n' | awk 'NF'
}
MEMBERS="$(normalize_members)"

for key in $MEMBERS; do
  [[ "$key" =~ ^[0-9a-f]{64}$ ]] || die "MEMBER_PUBKEYS 里有非法公钥：$key（必须是 64 位小写十六进制）"
done
[ -n "${UPSTREAM_API_KEY:-}" ] || warn "UPSTREAM_API_KEY 为空：起草与整理调用网关时会失败（若只是先跑通部署，可稍后再填）。"
case "${VAPID_SUBJECT:-}" in
  mailto:*) ;;
  *) die "VAPID_SUBJECT 必须是 mailto: 开头，例如 mailto:you@example.com" ;;
esac

APP_DOMAIN="${APP_DOMAIN:-}"
RELAY_DOMAIN="${RELAY_DOMAIN:-}"
GATEWAY_DOMAIN="${GATEWAY_DOMAIN:-}"
if [ -z "$APP_DOMAIN" ] || [ -z "$RELAY_DOMAIN" ]; then
  warn "APP_DOMAIN / RELAY_DOMAIN 还没填。域名模式请先填好再跑；无域名自测请改用 ./quick-start.sh（它会自动填临时地址）。"
  APP_DOMAIN="${APP_DOMAIN:-placeholder.invalid}"
  RELAY_DOMAIN="${RELAY_DOMAIN:-placeholder.invalid}"
fi

log "成员：$(printf '%s\n' "$MEMBERS" | wc -l) 个"
log "应用域名：$APP_DOMAIN"
log "中继域名：$RELAY_DOMAIN"

# ---- 3. 数据目录与占位文件（必须在 compose run 之前存在，否则 Docker 会把挂载点建成目录）----
mkdir -p data/relay data/gateway
chmod 700 data data/gateway 2>/dev/null || true
# relay 容器以 uid 10001 运行，绑定到 ./data/relay 的目录需要可写；这里给最宽松的权限，内测够用。
chmod 777 data/relay

[ -f data/relay-config.toml ] || cat > data/relay-config.toml <<'TOML'
[info]
relay_url = "ws://localhost:8080/"
name = "知衡内测中继"
[network]
address = "0.0.0.0"
port = 8080
[limits]
event_kind_allowlist = [1059, 30078]
[authorization]
community_open = true
nip42_auth = true
nip42_dms = true
pubkey_whitelist = []
TOML
[ -f data/gateway-config.json ] || printf '{}\n' > data/gateway-config.json
[ -f data/gateway-members.json ] || printf '[]\n' > data/gateway-members.json
chmod 600 data/gateway-config.json data/gateway-members.json

# ---- 4. 构建镜像 ----
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "构建镜像（relay 首次要在容器里编译 Rust，约 10–30 分钟；之后有缓存会快很多）…"
  docker compose build relay gateway web
fi

# ---- 5. VAPID（只生成一次，写回 .env）----
ensure_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    KEY="$key" VALUE="$value" node -e "const fs=require('fs');const p='.env';let s=fs.readFileSync(p,'utf8');s=s.replace(new RegExp('^'+process.env.KEY+'=.*$','m'),process.env.KEY+'='+process.env.VALUE);fs.writeFileSync(p,s)"
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

if [ -z "${VAPID_PUBLIC_KEY:-}" ] || [ -z "${VAPID_PRIVATE_KEY:-}" ]; then
  log "生成 VAPID 推送密钥…"
  out="$(docker compose run --rm --no-deps -T gateway node --input-type=module -e "import webpush from 'web-push'; const k=webpush.generateVAPIDKeys(); console.log('VAPID_PUBLIC_KEY='+k.publicKey); console.log('VAPID_PRIVATE_KEY='+k.privateKey)")"
  pub="$(printf '%s\n' "$out" | sed -n 's/^VAPID_PUBLIC_KEY=//p' | tail -1)"
  priv="$(printf '%s\n' "$out" | sed -n 's/^VAPID_PRIVATE_KEY=//p' | tail -1)"
  [ -n "$pub" ] && [ -n "$priv" ] || die "VAPID 生成失败，输出：$out"
  ensure_env VAPID_PUBLIC_KEY "$pub"
  ensure_env VAPID_PRIVATE_KEY "$priv"
  export VAPID_PUBLIC_KEY="$pub" VAPID_PRIVATE_KEY="$priv"
  log "VAPID 已生成并写入 .env（不要提交 .env）"
fi

# ---- 6. 验收用自测成员（可选）----
VERIFY_MEMBER_SECRET="${VERIFY_MEMBER_SECRET:-}"
VERIFY_MEMBER_PUBKEY="${VERIFY_MEMBER_PUBKEY:-}"
if [ "${SELF_TEST_MEMBER:-0}" = "1" ] && { [ -z "$VERIFY_MEMBER_SECRET" ] || [ -z "$VERIFY_MEMBER_PUBKEY" ]; }; then
  log "生成验收用自测成员密钥（仅内测；对外前把 .env 的 SELF_TEST_MEMBER 改为 0 并重跑）…"
  out="$(docker compose run --rm --no-deps -T gateway node --input-type=module -e "import {generateSecretKey,getPublicKey} from 'nostr-tools/pure'; const sk=generateSecretKey(); const hex=Array.from(sk,b=>b.toString(16).padStart(2,'0')).join(''); console.log('VERIFY_MEMBER_SECRET='+hex); console.log('VERIFY_MEMBER_PUBKEY='+getPublicKey(sk))")"
  VERIFY_MEMBER_SECRET="$(printf '%s\n' "$out" | sed -n 's/^VERIFY_MEMBER_SECRET=//p' | tail -1)"
  VERIFY_MEMBER_PUBKEY="$(printf '%s\n' "$out" | sed -n 's/^VERIFY_MEMBER_PUBKEY=//p' | tail -1)"
  { [ -n "$VERIFY_MEMBER_SECRET" ] && [ -n "$VERIFY_MEMBER_PUBKEY" ]; } || die "自测成员密钥生成失败，输出：$out"
  ensure_env VERIFY_MEMBER_SECRET "$VERIFY_MEMBER_SECRET"
  ensure_env VERIFY_MEMBER_PUBKEY "$VERIFY_MEMBER_PUBKEY"
  log "自测成员公钥：$VERIFY_MEMBER_PUBKEY"
fi
MEMBERS_ALL="$MEMBERS"
if [ -n "$VERIFY_MEMBER_PUBKEY" ]; then MEMBERS_ALL="$MEMBERS_ALL $VERIFY_MEMBER_PUBKEY"; fi

# ---- 7. 中继配置：用仓库里的 relay/configure.mjs，按成员公钥 + 当前中继地址生成 ----
log "生成中继配置 data/relay-config.toml（relay_url=wss://$RELAY_DOMAIN/）…"
( cd ../.. && RELAY_COMMUNITY_OPEN="${RELAY_COMMUNITY_OPEN:-true}" RELAY_PUBLIC_URL="wss://${RELAY_DOMAIN}/" node relay/configure.mjs $MEMBERS_ALL )
mv -f ../../relay/config.local.toml data/relay-config.toml

# 一次性部署口令只留本机。重跑不覆盖口令、已认领记录或已加入成员。
node --input-type=module <<'NODE'
import {existsSync,writeFileSync,chmodSync} from 'node:fs';import {randomBytes,createHash} from 'node:crypto';
if(!existsSync('data/gateway/seed.json')){const token=randomBytes(32).toString('base64url');writeFileSync('data/gateway/seed.json',JSON.stringify({tokenHash:createHash('sha256').update(token).digest('hex')}),{mode:0o600});writeFileSync('data/teacher-setup-code.txt',token+'\n',{mode:0o600})}
if(existsSync('data/teacher-setup-code.txt'))chmodSync('data/teacher-setup-code.txt',0o600)
NODE
log "社区老师首次登记：在本机查看 data/teacher-setup-code.txt，把口令输入手机的‘我是这个社区的老师’。不要公开此文件。"

# ---- 8. 网关配置与成员名单 ----
log "生成网关配置 data/gateway-config.json 并保留成员名单 data/gateway/members.json…"
APP_ORIGIN="https://${APP_DOMAIN}" MEMBERS_ALL="$MEMBERS_ALL" \
UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:-https://api.deepseek.com}" \
UPSTREAM_MODEL="${UPSTREAM_MODEL:-deepseek-chat}" \
node scripts/generate-gateway.mjs

# ---- 9. 校验 compose 配置能展开 ----
docker compose config >/dev/null || die "compose 配置校验失败：看上面的报错。"
log ""
log "完成："
log "  - 数据目录：$(pwd)/data（已加入 .gitignore，备份就备份这个目录）"
log "  - 域名模式启动：./start.sh"
log "  - 无域名自测：./quick-start.sh（会生成 trycloudflare 临时地址并写回 .env）"
log "  - 验收探测：./verify.sh"
