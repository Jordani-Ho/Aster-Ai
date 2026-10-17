
每次 NIP-98 请求用 crypto.getRandomValues 生成 128 位随机 nonce 标签，避免同秒同内容的合法重试被误判为重放；原事件重放仍由网关拒绝。
