FROM node:22-bookworm-slim

# 模型网关：无状态转发 + 推送订阅（唯一有状态部分，写 /app/data）。
WORKDIR /app
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev
COPY gateway/ ./
# Single service catalog shared with the browser; no duplicate hardcoded endpoints.
COPY app/src/core/llm/providers.json ./src/core/llm/providers.json
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server.js", "/app/config.json"]
