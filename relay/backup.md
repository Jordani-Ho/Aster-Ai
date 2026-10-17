# M1-06 备份中继策略扩展

本卡从最新main独立分支，不包含未合并PR #16的传输实现。浏览器备份有独立NIP-01/42适配器；服务端部署需先应用PR #16（固定上游b5c1f642）的community-policy.patch，再应用本目录backup-policy.patch。

构建步骤：在#16 Dockerfile的cargo build之前增加COPY backup-policy.patch /backup.patch和`git apply --check /backup.patch && git apply /backup.patch`；生成配置中的event_kind_allowlist改成`[1059, 30078]`。这些是#16基础上的部署扩展，不要只用原版公开中继或只开启nip42_auth。

扩展只允许AUTH成员发布本人签名的kind30078，并仅允许d为aster.backup.0/1/2三个槽位；历史和实时读取都限于AUTH本人作者。保留#16的消息收件隔离。三个地址事件由成熟中继按NIP-01替换旧版本，备份不附30天expiration，避免长期没打开应用后备份全部过期。

上游SQLite对参数可替换事件的实际清理/磁盘占用及容器构建仍需部署方验收。测试中的内存中继验证逻辑上仅有最近三份，不能据此声称实际磁盘空间已回收。Docker/Rust不在本机，未做真实容器验收。
参考：[NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md)、[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)。
