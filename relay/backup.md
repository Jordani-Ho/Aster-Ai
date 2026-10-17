# M1-06 备份中继策略扩展

本卡已rebase到包含PR #16的main。浏览器备份使用独立NIP-01/42适配器；relay/Dockerfile自动按顺序应用community-policy.patch与backup-policy.patch。

启动：运行 `node relay/configure.mjs <成员公钥> ...` 生成包含 `[1059, 30078]` 的配置，再运行 `docker compose -f relay/compose.yaml up --build -d`。无需手工修改Dockerfile或配置白名单；已有配置需要重新生成。

扩展只允许AUTH成员发布本人签名的kind30078，并仅允许d为aster.backup.0/1/2三个槽位；历史和实时读取都限于AUTH本人作者。保留#16的消息收件隔离。三个地址事件由成熟中继按NIP-01替换旧版本，备份不附30天expiration，避免长期没打开应用后备份全部过期。

上游SQLite对参数可替换事件的实际清理/磁盘占用及容器构建仍需部署方验收。测试中的内存中继验证逻辑上仅有最近三份，不能据此声称实际磁盘空间已回收。Docker/Rust不在本机，未做真实容器验收。
参考：[NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md)、[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)。
