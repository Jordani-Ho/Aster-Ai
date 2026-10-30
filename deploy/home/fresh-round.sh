#!/usr/bin/env bash
# V2-42：内测每一轮从头再来——一条命令清场。
# 把上一轮的老师登记凭据、核心成员凭据和成员名单“存在才移、不删”地挪到 data/backup/fresh-<时间>/，
# 再跑 update.sh 生成新口令（update.sh 会等网页就绪后再跑 verify.sh）。
# 不删任何文件、不动中继数据、不重启 cloudflared，网址不变。
# 可选环境变量：
#   SKIP_BROWSER=1   不动 Windows 桌面快捷方式、不打开浏览器（测试用）
# 用法：cd deploy/home && ./fresh-round.sh
set -euo pipefail
cd "$(dirname "$0")"

log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "缺少 .env（第一次部署请先 cp .env.example .env）。"
command -v docker >/dev/null 2>&1 || die "未找到 docker。"
command -v node >/dev/null 2>&1 || die "缺少 node（setup.sh 也要求 Node 22）。"
command -v curl >/dev/null 2>&1 || die "缺少 curl（update.sh 用它等网页就绪）：sudo apt-get install -y curl"
APP_DOMAIN="$(sed -n 's/^APP_DOMAIN=//p' .env | tail -1 | tr -d '\r')"

# 1) 上一轮的凭据与名单：存在才移，不删；连 data/backup/last 里的同名文件一起移。
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="data/backup/fresh-$STAMP"
while [ -e "$DEST" ]; do DEST="data/backup/fresh-$STAMP-$$"; done
mkdir -p "$DEST"
moved=0
for file in \
  data/gateway/seed.json \
  data/setup/teacher-setup-code.txt \
  data/setup/teacher-setup.html \
  data/backup/last/seed.json \
  data/backup/last/teacher-setup-code.txt \
  data/backup/last/teacher-setup.html \
  data/gateway/core-seed.json \
  data/setup/core-member-code.txt \
  data/setup/core-member.html \
  data/backup/last/core-seed.json \
  data/backup/last/core-member-code.txt \
  data/backup/last/core-member.html \
  data/gateway/members.json \
  data/backup/last/members.json
do
  if [ -f "$file" ]; then mv -v "$file" "$DEST/"; moved=$((moved + 1)); fi
done
if [ "$moved" -eq 0 ]; then
  rmdir "$DEST" 2>/dev/null || true
  die "没找到上一轮的登记凭据或成员名单，不用清场。"
fi
log "上一轮的凭据与成员名单已移到 $(pwd)/$DEST（没有删）。"
log ""

# 2) 重新生成口令、重建环境；update.sh 会等网页就绪后再跑 verify.sh。
log "重新生成口令、重建环境（不碰 cloudflared，网址不变）…"
./update.sh

# 3) 老师浏览器：新建一个空的 Chrome 配置目录，把桌面快捷方式改成指向它。
#    电脑当老师时，直接用它打开带一次性口令的登记链接（和二维码里是同一个链接），第 2 步口令自动填好；
#    扫码页照旧生成，留给用手机当老师的情况。
APP_URL="https://${APP_DOMAIN}"
APP_HOME="${APP_URL}/"
QR_PAGE="$(pwd)/data/setup/teacher-setup.html"
CODE_FILE="$(pwd)/data/setup/teacher-setup-code.txt"
# 登记链接 = 部署网址 + #setup=<口令>，与 scripts/setup-link.mjs 生成二维码时用的完全同一个地址；
# 口令只在 # 后面（浏览器不发给服务器），终端和日志都不打印它。
SETUP_URL=""
if [ -s "$CODE_FILE" ]; then
  setup_token="$(tr -d '[:space:]' < "$CODE_FILE" 2>/dev/null || true)"
  if [ -n "$setup_token" ]; then
    encoded_token="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$setup_token" 2>/dev/null || true)"
    if [ -n "$encoded_token" ]; then SETUP_URL="${APP_HOME%/}/#setup=${encoded_token}"; fi
  fi
fi
browser_failed=0
setup_teacher_browser() {
  local stamp win_profile desktop lnk qr_win payload encoded open_url ps_app_home ps_open_url
  stamp="$(date +%Y%m%d-%H%M)"
  win_profile="$(powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('LocalApplicationData')" | tr -d '\r')\\Aster-Test\\知衡内测-老师-$stamp"
  desktop="$(powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('Desktop')" | tr -d '\r')"
  lnk="$desktop\\知衡内测-老师Chrome.lnk"
  qr_win="$(wslpath -w "$QR_PAGE" 2>/dev/null || true)"
  # 这次打开的地址：优先带口令的登记链接；没有口令（比如已经有老师登记）才退回扫码页/首页。
  if [ -n "$SETUP_URL" ]; then open_url="$SETUP_URL"
  elif [ -n "$qr_win" ]; then open_url="$qr_win"
  else open_url="$APP_HOME"; fi
  ps_app_home="${APP_HOME//\'/\'\'}"
  ps_open_url="${open_url//\'/\'\'}"
  # 用 -EncodedCommand（UTF-16LE）传脚本：不再落 /tmp/*.ps1，
  # 免得 Windows PowerShell 按 ANSI 读无 BOM 的 UTF-8 文件把中文路径和描述解析坏。
  payload="$(cat <<PS
\$ErrorActionPreference = 'Stop'
\$profile = '$win_profile'
New-Item -ItemType Directory -Force -Path \$profile | Out-Null
\$lnk = '$lnk'
\$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path \$chrome)) {
  \$localChrome = Join-Path \$env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'
  if (Test-Path \$localChrome) { \$chrome = \$localChrome } else { throw '没找到 Chrome（Program Files 或 %LOCALAPPDATA%\Google\Chrome\Application\chrome.exe）' }
}
\$appHome = '$ps_app_home'
\$openUrl = '$ps_open_url'
\$baseArgs = '--user-data-dir="' + \$profile + '" --no-first-run --no-default-browser-check --new-window '
\$s = (New-Object -ComObject WScript.Shell).CreateShortcut(\$lnk)
\$s.TargetPath = \$chrome
\$s.Arguments = \$baseArgs + '"' + \$appHome + '"'
\$s.WorkingDirectory = 'C:\Users'
\$s.Description = '知衡内测：老师这台电脑的 Chrome（每一轮一个新配置目录）'
\$s.Save()
\$chromeArgs = \$baseArgs + '"' + \$openUrl + '"'
Start-Process -FilePath \$chrome -ArgumentList \$chromeArgs | Out-Null
Write-Output ('profile=' + \$profile)
PS
)"
  if ! encoded="$(printf '%s' "$payload" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)"; then
    log "提醒：老师浏览器没配置成功（生成 -EncodedCommand 失败，缺 iconv 或 base64？）。可以手动新建 Chrome 配置目录再改桌面快捷方式。"
    return 1
  fi
  if ! powershell.exe -NoProfile -EncodedCommand "$encoded"; then
    log "提醒：老师浏览器没配置成功（看上面的 PowerShell 报错）。可以手动新建 Chrome 配置目录再改桌面快捷方式。"
    return 1
  fi
  log "老师浏览器：新配置目录 $win_profile（旧的没有删）。"
  log "桌面快捷方式已改成指向它（打开首页 ${APP_HOME}）：$lnk"
  if [ -n "$SETUP_URL" ]; then
    log "已用新配置打开老师登记链接：${APP_URL}/#setup=（带这一轮的一次性口令，第 2 步会自动填好；口令在 # 后，不打印）"
  elif [ -n "$qr_win" ]; then
    log "提醒：没有待用口令，已用新配置打开老师登记扫码页：$qr_win"
  else
    log "提醒：没有待用口令，已用新配置打开 ${APP_HOME}"
  fi
  if [ -f "$QR_PAGE" ]; then log "老师登记扫码页照旧在（手机当老师时扫它）：$QR_PAGE"; fi
}

log ""
if [ "${SKIP_BROWSER:-0}" = "1" ]; then
  log "提醒：SKIP_BROWSER=1，跳过老师浏览器配置（新配置目录与桌面快捷方式）。"
elif command -v powershell.exe >/dev/null 2>&1; then
  setup_teacher_browser || browser_failed=1
else
  log "提醒：没找到 powershell.exe，老师浏览器没有配置。可以手动新建 Chrome 配置目录，再把桌面「知衡内测-老师Chrome」指向它。"
  browser_failed=1
fi

# 4) 收尾提示。
log ""
log "清场完成："
if [ -f data/setup/teacher-setup-code.txt ]; then log "  新的老师登记口令：$(pwd)/data/setup/teacher-setup-code.txt"; fi
if [ -n "$SETUP_URL" ]; then log "  电脑当老师：新配置直接打开带口令的登记链接，第 2 步口令自动填好；手机当老师才用下面的扫码页。"; fi
if [ -f data/setup/teacher-setup.html ]; then log "  新的老师登记扫码页：$(pwd)/data/setup/teacher-setup.html"; fi
log "  上一轮的备份：$(pwd)/$DEST"
log ""
log "提醒：两台手机各点一次「设置 → 内测：清空这台设备 → 清空这台设备上的知衡」，回到第一次打开的样子。"
log "提醒：核心成员随名单一起清掉了，这一轮要按《内测怎么开始》第六节第 14 项重新登记核心成员。"
log "提醒：只有最新登记的那位算老师；之前那位老师发出去的进馆邀请会被拒。"

if [ "$browser_failed" = "1" ]; then
  printf '失败：老师浏览器没有配置成功，按上面的提示手动补一下；环境本身已经清场完成。\n' >&2
  exit 1
fi
