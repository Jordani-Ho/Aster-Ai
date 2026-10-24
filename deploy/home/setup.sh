#!/usr/bin/env bash
# 知衡内测部署 · 配置生成与预检（第二版）。
# 在 WSL2 里以普通用户运行：./setup.sh
# 不调用 sudo，不安装任何东西；Docker 需要先按 README 第 1 步装好。
# 第二版没有旧版的成员名单与预留位置：中继用 community_open（仍强制 NIP-42 认证），
# 人员靠邀请链接登记；老师第一次登记用 data/teacher-setup-code.txt 的一次性口令。
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
# V2-29：版本号由宿主机算好（下面第 7c 节）。显式从环境传入的优先（也方便测试/CI），
# 注意要在 source .env 之前记下来，避免上一次写进 .env 的旧值顶掉这次计算的。
HOST_APP_VERSION="${APP_VERSION:-}"
HOST_APP_BUILD_DATE="${APP_BUILD_DATE:-}"
[ -f .env ] || die "缺少 .env。请先执行：cp .env.example .env。"
chmod 600 .env 2>/dev/null || true
set -a
# shellcheck disable=SC1091
. ./.env
set +a

[ -n "${UPSTREAM_API_KEY:-}" ] || warn "UPSTREAM_API_KEY 为空：内测备用模型不可用，不影响使用者自己的模型直连或凭证代理。"
case "${VAPID_SUBJECT:-}" in
  mailto:*) ;;
  *) die "VAPID_SUBJECT 必须是 mailto: 开头，例如 mailto:you@example.com" ;;
esac

APP_DOMAIN="${APP_DOMAIN:-}"
RELAY_DOMAIN="${RELAY_DOMAIN:-}"
if [ -z "$APP_DOMAIN" ] || [ -z "$RELAY_DOMAIN" ]; then
  warn "APP_DOMAIN / RELAY_DOMAIN 还没填。无域名自测请用 ./quick-start.sh（它会自动填临时地址）。"
  APP_DOMAIN="${APP_DOMAIN:-placeholder.invalid}"
  RELAY_DOMAIN="${RELAY_DOMAIN:-placeholder.invalid}"
fi

log "应用域名：$APP_DOMAIN"
log "中继域名：$RELAY_DOMAIN"
log "开放模式：${RELAY_COMMUNITY_OPEN:-true}（第二版没有成员白名单；未认证连接仍不能读写消息）"

# ---- 3. 数据目录与占位文件（必须在 compose run 之前存在，否则 Docker 会把挂载点建成目录）----
mkdir -p data/relay data/gateway
chmod 700 data data/gateway 2>/dev/null || true
# relay 容器以 uid 10001 运行，绑定到 ./data/relay 的目录需要可写；这里给最宽松的权限，内测够用。
chmod 777 data/relay

# ---- 3b. 数据保命（V2-28）：成员名单/一次性口令先备份；被误删或清空就先从上次备份恢复 ----
node scripts/safeguard-data.mjs prepare || die "部署数据备份/恢复失败（scripts/safeguard-data.mjs）"

[ -f data/relay-config.toml ] || cat > data/relay-config.toml <<'TOML'
[info]
relay_url = "ws://localhost:8080/"
name = "知衡内测中继"
[network]
address = "0.0.0.0"
port = 8080
[limits]
event_kind_allowlist = [1059]
[authorization]
community_open = true
nip42_auth = true
nip42_dms = true
pubkey_whitelist = []
TOML
[ -f data/gateway-config.json ] || printf '{}\n' > data/gateway-config.json
chmod 600 data/gateway-config.json

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

# ---- 6. 中继配置：第二版只有 community_open，不写成员白名单 ----
log "生成中继配置 data/relay-config.toml（relay_url=wss://$RELAY_DOMAIN/）…"
( cd ../.. && RELAY_COMMUNITY_OPEN="${RELAY_COMMUNITY_OPEN:-true}" RELAY_PUBLIC_URL="wss://${RELAY_DOMAIN}/" node relay/configure.mjs )
mv -f ../../relay/config.local.toml data/relay-config.toml

# 一次性部署口令只留本机。重跑不覆盖口令或已认领记录。
node --input-type=module <<'NODE'
import {existsSync,writeFileSync,chmodSync} from 'node:fs';import {randomBytes,createHash} from 'node:crypto';
if(!existsSync('data/gateway/seed.json')){const token=randomBytes(32).toString('base64url');writeFileSync('data/gateway/seed.json',JSON.stringify({tokenHash:createHash('sha256').update(token).digest('hex')}),{mode:0o600});writeFileSync('data/teacher-setup-code.txt',token+'\n',{mode:0o600})}
if(existsSync('data/teacher-setup-code.txt'))chmodSync('data/teacher-setup-code.txt',0o600)
NODE
log "社区老师首次登记：在本机查看 data/teacher-setup-code.txt，把口令输入手机/电脑的‘我是这个社区的老师’。不要公开此文件。"
log "复制文件里的那串口令后，直接粘贴到「登记口令」框里即可，不用自己编；前后空格和换行会自动去掉。"

# ---- 7. 网关配置与成员名单 ----
log "生成网关配置 data/gateway-config.json 与成员名单 data/gateway/members.json…"
APP_ORIGIN="https://${APP_DOMAIN}" \
UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:-}" \
UPSTREAM_MODEL="${UPSTREAM_MODEL:-}" \
node scripts/generate-gateway.mjs

# ---- 7b. 社区网关模型开关（V2-28）：只有配了上游账户，学生才能不填自己的 Key 先用 ----
COMMUNITY_VALUE="$(node --input-type=module -e "import {readFileSync} from 'node:fs';let on=false;try{const c=JSON.parse(readFileSync('data/gateway-config.json','utf8'));on=Boolean(c.upstreamBaseUrl&&c.upstreamModel&&c.fallbackEnabled!==false)}catch{};process.stdout.write(on?'1':'0')")"
ensure_env COMMUNITY_MODEL "$COMMUNITY_VALUE"
if [ "$COMMUNITY_VALUE" = "1" ]; then
  log "社区网关模型：已开启（学生可以先不填自己的 Key）"
else
  log "社区网关模型：未开启（学生在网页里接入自己的模型）"
fi

# ---- 7c. 版本号（V2-29）：宿主机算好短提交号与构建日期，写进 .env → compose 传给 web 容器；----
# web 镜像里没有 .git（.dockerignore 排除），页面是容器启动时由 entrypoint 构建的，
# 所以必须靠容器环境变量把版本号带进去，容器内 npm run build 才能读到 APP_VERSION。
APP_VERSION_VALUE="$HOST_APP_VERSION"
if [ -z "$APP_VERSION_VALUE" ]; then
  APP_VERSION_VALUE="$(git rev-parse --short HEAD 2>/dev/null || true)"
fi
[ -n "$APP_VERSION_VALUE" ] || APP_VERSION_VALUE="unknown"
APP_BUILD_DATE_VALUE="$HOST_APP_BUILD_DATE"
[ -n "$APP_BUILD_DATE_VALUE" ] || APP_BUILD_DATE_VALUE="$(date +%m-%d)"
ensure_env APP_VERSION "$APP_VERSION_VALUE"
ensure_env APP_BUILD_DATE "$APP_BUILD_DATE_VALUE"
log "版本号：$APP_VERSION_VALUE · $APP_BUILD_DATE_VALUE（web 容器启动构建时注入页面）"

# ---- 8. 校验 compose 配置能展开 ----
docker compose config >/dev/null || die "compose 配置校验失败：看上面的报错。"
log ""
log "完成："
log "  - 数据目录：$(pwd)/data（本机个人数据，不要提交）"
log "  - 无域名自测启动：./quick-start.sh（会生成 trycloudflare 临时地址并写回 .env）"
log "  - 固定域名模式（下一步再做）：./start.sh"
log "  - 验收探测：./verify.sh"
