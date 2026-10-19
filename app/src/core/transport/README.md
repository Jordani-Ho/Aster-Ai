# 中继传输（M1-05）

createTransport({privateKey, relays, onMessage, onStatus?})返回start/send/sync/close。配置多个社区中继可用，不依赖kind10050。
send(recipient,{type,version:1,payload})返回消息rumor id；至少一个中继对收件人包裹和发件人副本都确认OK后完成，不表示接收者已经阅读。未连接可先排队；1秒重试，断线后重新AUTH并订阅，收到重复包裹按内部rumor id去重。onMessage可返回Promise，成功后才登记去重。close取消待发送并覆写私钥副本。

使用已批准nostr-tools@2.25.2：kind14 rumor→kind13 seal→kind1059包裹，NIP-44 v2加密与Schnorr签名。不自造算法。每条消息加入内层随机nonce，避免同秒同内容被误去重。给收件人和发件人各包一份；外层只含收件人和过期标签。
验证外层签名时逐字段重建，避免E-004缓存；解密时库验证seal签名及seal/rumor发件人一致，另校验rumor id、kind、收件人、信封与过期。
中继AUTH使用本人身份，消息外层用一次性密钥，隐私边界见relay/README.md及发起人决策。seal与外层时间随机化；expiration不暴露真实发送秒。

网络队列与去重表仅当前会话内存保存：重载页面会丢待发包裹，已收事件也可能重新回调；业务层必须按message.id持久化并幂等处理。未实现业务消息、UI、推送、投递确认删除；记录备份由 V2-05 的师生互为备份消息（`records.*`）用本层发送。拒绝无效版本，payload必须JSON；业务各卡仍需验证自己的payload。
只有ping是本卡定义的业务类型，其他合法命名留给后续卡；不接AI或自动签字。

测试可注入Socket，内存模拟中继不访问网络，时间推进30秒验证恢复与去重；真实Docker验收尚未运行。
