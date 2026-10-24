FROM node:22-bookworm-slim

# 手机网页应用：镜像里带源码与构建工具，容器启动时按 VITE_ 环境变量重新构建，
# 这样没有域名（trycloudflare 每次地址不同）时也能让页面用上当前隧道地址。
# V2-29：版本号也可能来自镜像构建参数（默认 unknown/空）；部署时 compose 在容器启动时
# 覆写这两个环境变量（取自 .env 的 APP_VERSION / APP_BUILD_DATE），页面构建读得到。
ARG APP_VERSION=unknown
ARG APP_BUILD_DATE=
ENV APP_VERSION=${APP_VERSION} APP_BUILD_DATE=${APP_BUILD_DATE}
WORKDIR /srv
COPY app/package.json app/package-lock.json ./app/
RUN cd app && npm ci
COPY domain ./domain
COPY prompts ./prompts
COPY app ./app
COPY deploy/home/web/serve.mjs deploy/home/web/entrypoint.sh /srv/
RUN chmod +x /srv/entrypoint.sh
WORKDIR /srv
EXPOSE 8080
ENTRYPOINT ["/srv/entrypoint.sh"]
