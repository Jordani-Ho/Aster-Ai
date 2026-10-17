# relay · M1-05 社区中继

## 选型

| 候选 | 原生支持与限制 | 决定 |
| --- | --- | --- |
| nostr-rs-relay | Rust/SQLite，NIP-40、42、1059收信隔离；原始作者白名单与一次性包裹冲突，默认会把包裹也发给外层签名者 | 选用，附可审查的最小成员授权补丁 |
| strfry | C++/LMDB，成熟高吞吐，写入插件可拒绝事件；仅写入插件不足以落实本卡按AUTH身份限制历史/实时读取 | 不选，M1优先小规模、授权路径可核对 |

上游固定提交 `b5c1f642e4f4c3b9c54f5d18d66f4c53642076b4`（2026-05-22），版本0.10.0，MIT。
来源：[nostr-rs-relay](https://github.com/scsibug/nostr-rs-relay/tree/b5c1f642e4f4c3b9c54f5d18d66f4c53642076b4)、[strfry插件](https://github.com/hoytech/strfry/blob/master/docs/plugins.md)。不自写中继数据库或加密。

community-policy.patch只调整授权策略：AUTH必须是成员；EVENT/REQ须已鉴权；白名单检查连接公钥，允许随机作者的包裹；历史与实时投递仅p等于鉴权公钥；过期事件不投递。只收带expiration的1059。未配置白名单时拒绝全部，而不是公开访问。

## 本地启动

先在仓库根目录运行 `node relay/configure.mjs <老师公钥> <学生公钥>`，只填合成开发公钥；生成的config.local.toml不入库。
然后 `docker compose -f relay/compose.yaml up --build -d`，客户端配置 `ws://localhost:8080/`。局域网手机开发须部署可信HTTPS/WSS反代，并把RELAY_PUBLIC_URL设为客户端实际访问的完整中继URL后重新生成配置。
单事件上限2MiB，外层加密与base64也计入上限；照片必须压缩并检查最终包裹大小。

关闭全部Rust日志（RUST_LOG=off）和Docker日志驱动；反向代理也必须禁用访问日志。不得记录连接身份、IP、时间、事件或内容。数据库只存加密事件。配置白名单变动后需重启。

## 已裁决的隐私边界

按team/decisions.md：中继看得到收件公钥、AUTH连接者和连接时间，运营者可能关联这些信息；看不到内容，包裹作者是一次性随机公钥。seal/包裹时间按NIP-59随机化。expiration基于随机外层时间加30天，避免减去30天直接还原真实发送秒；实际保存约28—30天。不会声称完全匿名。
不做kind10050发现，统一用配置的社区中继；不做投递后立即删除，依靠NIP-40过期。M2再评估每段关系独立收信密钥。

## 验证与限制

app传输测试用内存模拟中继验证真实NIP-42签名与成员限制、NIP-17/44/59解密、过期、30秒断线重连及去重、第三者不可解密。
本环境没有Docker/Rust，未运行容器构建或真实中继测试；补丁已对固定上游做应用检查，部署前必须构建并以非成员/其他收件人探针验收，不能把模拟测试当作容器验收。
M1-06的备份事件及“最近3份”保留策略不在本卡实现；本配置只允许1059，后续备份卡扩展。
