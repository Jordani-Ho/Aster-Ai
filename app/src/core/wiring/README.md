# 应用串联（M1-15a）

`createWiring({identity, store, relays, socket?, notifier?, onStatus?, onChange?, onError?})` 把一条问诊链路接起来：

- **一个** `createTransport` 实例，收到的消息交给 `core/inbox` 的 `createInbox` 分发；`ledger.*` 再转给同一实例里的 `createLedgerSync`。
- `send(recipient, envelope)` 是唯一发送入口：`transport.send` 成功后调用一次 `notifier(recipient)`（M1-08 的 `notifyRecipient`）；通知失败不影响发送结果。
- `sendConsult(pkg)` 发问诊包与每张照片；`flushIntakeOutbox()` 把 M1-05 之前的本机待发件真实发出，成功后删除。
- `start()` / `close()` 控制 transport 与账本控制器；连接就绪时自动 `sync()` 并补一次账本对账与待发队列。

界面侧：`App.tsx` 在身份就绪且配置了社区中继时创建一个 wiring；学生端采集页用 `sendConsult` 真实发送，老师端问诊箱用 `send` + `ledger` 完成签字交还与扣费。没有配置中继时页面明确提示，采集仍可先存本机待发集合。

测试不新增依赖：`inbox.test.ts` 注入内存中继（`socket`）与假 LLM，不连真实 relay/gateway。

M1-15b：收到信封并处理完后调用 onChange；App发本机事件更新收件箱/病历页。恢复前等待共享连接关闭，恢复或中继配置变化后重建共享wiring；LedgerSettings的managed模式在初始化期间也不会另建账本控制器。
