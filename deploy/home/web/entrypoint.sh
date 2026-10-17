#!/bin/sh
# 容器每次启动时用当前 VITE_ 变量重新构建网页应用，再启动只读静态服务。
set -eu
: "${VITE_COMMUNITY_RELAYS:?缺少 VITE_COMMUNITY_RELAYS（由 compose 从 .env 的 RELAY_DOMAIN 生成）}"
: "${VITE_PUSH_GATEWAY_URL:?缺少 VITE_PUSH_GATEWAY_URL（由 compose 从 .env 的 APP_DOMAIN 生成）}"
echo "web: building app for relay=${VITE_COMMUNITY_RELAYS} gateway=${VITE_PUSH_GATEWAY_URL}"
cd /srv/app
npm run build
cd /srv
exec node /srv/serve.mjs
