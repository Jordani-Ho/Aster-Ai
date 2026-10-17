FROM node:22-bookworm-slim

# 手机网页应用：镜像里带源码与构建工具，容器启动时按 VITE_ 环境变量重新构建，
# 这样没有域名（trycloudflare 每次地址不同）时也能让页面用上当前隧道地址。
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
