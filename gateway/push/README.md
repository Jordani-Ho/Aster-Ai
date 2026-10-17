# 推送服务（M1-08）

这是 gateway 唯一有状态的部分；不存消息、病历、文字，只存公钥与浏览器订阅 endpoint/keys。
所有请求走现有成员 NIP-98 鉴权、防重放、1MB上限及全局调用方限流。仅 POST：

- `/push/subscribe`：`{ subscription: PushSubscription.toJSON() }`，只给签名本人保存/覆盖一台设备；忽略 pubkey 和额外字段。
- `/push/unsubscribe`：`{}`，只删除签名本人订阅，可重复调用。
- `/push/notify`：`{ pubkey }`，忽略自定义文字；每调用方对每收件公钥滑动60秒最多5次，超出429。无订阅也返回202，不披露订阅状态。

固定载荷 `知衡：有新消息`；404/410删除失效订阅；其余投递错误也返回 202，只在网关日志里记状态码 502（不记端点）。投递超时10秒，TTL60秒；不记录载荷、订阅或端点到日志。
`push-subscriptions.json` 不进仓库；临时文件写入并fsync再rename，失败保留旧文件及内存快照。进程重启只读取正式文件。
部署需给文件目录写权限，限制部署账户访问（POSIX文件mode0600；Windows由ACL管理）。只支持一个gateway进程写这一个文件，不适用于多实例共享文件或网络文件系统。

## 部署

从 gateway 运行 `npx --no-install web-push generate-vapid-keys --json`，一次生成并由部署方安全保存；不要把输出提交到仓库。
设置环境变量 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`（部署方联系邮箱 mailto:...）。密钥不写文件；客户端只配置公钥。
config.json 的 push.subscriptionsFile 指定 JSON 路径（默认当前目录 push-subscriptions.json）。配置 push 为 null 可关闭服务，推送路由仍鉴权后返回503。
HTTPS反向代理将应用与gateway放到同源，`/push/*`代理至gateway，设置 publicUrl 为公开源；本服务不增加宽泛CORS。

端点默认仅放行 fcm.googleapis.com、updates.push.services.mozilla.com、web.push.apple.com 的HTTPS443精确主机。其他浏览器供应商需部署方审核后在 push.endpointHosts 显式添加精确主机；禁止通配符、localhost、内网地址。服务不跟随重定向。这样限制成员借推送做任意URL请求。

依赖：已预批 `web-push@3.6.7`，MPL-2.0，npm发布于2024-01-16T13:48:01.065Z，锁定确切版本。
库文档：https://github.com/web-push-libs/web-push/tree/v3.6.7 （VAPID/sendNotification）。

## 验证边界

测试用合成订阅及注入的发送器验证持久化、固定文案、注销、到期限流、崩溃恢复；真实HTTP验证鉴权/防重放/大小限制/404，既有网关测试继续运行。
未接真实推送供应商，未使用真实设备令牌，未声称手机已收到推送；部署方需用自己的VAPID在HTTPS和已安装iOS上做设备验收。
