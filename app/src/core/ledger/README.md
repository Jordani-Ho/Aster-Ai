# 康币账本核心

`M1-14a` 的纯逻辑账本（技术白皮书 §8.2）：一本账由老师写的记账链和学生写的异议列表组成。
chain.ts / verify.ts 保持纯逻辑；M1-14b 的 sync.ts 经 core/transport 同步，runtime.ts 连接应用生命周期与推送。

## 结构

`Ledger = { teacher, student, events, disputes }`：

- `events`：**记账链，只由老师写**（`topup` 充值、`gift` 赠送、`charge` 扣费、`refund` 退款）。
  每条都补 `prev` 指向上一条事件的 `id`（sha256 哈希链），按顺序编号。
- `disputes`：**异议列表，由学生签名，不进链、没有 prev**。每条用 `disputeFor` 指向链里一条
  `charge` 事件的 `id`。

单一写入者是为了避免分叉：老师和学生各拿一部手机，如果两人的事件接在同一条链上，
迟早会在同一个“上一条”之后各写一条，合并时链就断了。异议不进链后，M1-14b 对账只需要比较
两端链的最后一条 `id`，简单可靠；学生在自己副本里提异议只追加 `disputes`，不影响老师的链。

一条账本事件就是一条 kind `2729` 的 nostr 签名事件（内部 kind：只作为礼物包裹的内层 rumor
传输，不裸发到中继，所以不存在 kind 冲突）。content 是账本字段 JSON，`tags` 绑定这本账的
（老师公钥，学生公钥）。签名用已批准的 `nostr-tools@2.25.2` 的 `finalizeEvent`，不自造签名算法。

## 余额与欠费

- `balance(ledger)` = 充值 + 赠送 − 扣费 − 退款；异议不影响余额；允许为负（L3）。
- `overdueSince(ledger)`：返回“余额从某个时间点起一直是负数”的起始时间。账本末尾余额不为负时返回 `null`；
  余额回正后再次转负时，返回后一段连续欠费的起始时间。

## 校验

`verify(ledger)` 分别校验两部分，返回问题列表 `{ part, index, code, message }`，空数组表示通过。

记账链（`part: "chain"`）：

- `wrong-kind` / `bad-signature`：kind 正确、事件 id 与 content 一致、Schnorr 签名有效；
- `wrong-tags`：事件绑定的是这本账的师生公钥；
- `wrong-issuer`：记账事件只能由老师签发；
- `broken-chain`：`prev` 等于上一条事件的 id（第一条必须为 `null`）；
- `time-regressed` / `created-at-mismatch`：时间不倒退，且与 nostr 的 `created_at` 一致；
- `invalid-amount`：金额必须是正整数；
- `invalid-reason` / `invalid-record-hash`：扣费事由与关联哈希格式；
- `refund-exceeds-topups`：L2，退款金额不得超过“累计充值 − 累计退款”（按事件顺序累计到该条）；
- `unknown-refund-target`：退款引用必须指向之前的链上事件。

异议（`part: "disputes"`）：

- `wrong-kind` / `bad-signature` / `wrong-tags` / `created-at-mismatch`：同上；
- `wrong-issuer`：异议只能由学生签发；
- `unknown-dispute-target`：`disputeFor` 必须指向链里存在的一条 `charge`；
- `dispute-too-late` / `dispute-too-early`：P7，异议必须在扣费后 7 天内（含第 7 天）；
- `missing-reason`：异议必须写一句话理由。

注意：`nostr-tools` 的 `verifyEvent` 会在事件对象上缓存“已验证”，展开复制会把这个缓存带过去；
因此 `verify` 先用 `getEventHash` 重算事件 id，再验签名。这个坑记录在 `team/mistakes.md` E-004。

## 已知边界

- 哈希链能发现内容被改、中间事件被删，但**发现不了账本末尾被截断**；改成单一写入者后，
  M1-14b 对账只需比较两端链的最后一条 id。
- 老师持有记账链的唯一写入密钥，理论上可以重写自己的历史（重签整条链）；两端各存一份、比对最后一条 id 才能发现分歧。
- **异议时间以学生自报时间判断是否在扣费后 7 天内（含第 7 天）。** 根据发起人 2026-10-17 裁决，
  老师收到时拒收早于扣费时间、晚于老师实际收到时间、或自报超过 7 天的异议，并回说明。
  老师收到时间比自报晚超过 24 小时仍入列表，显示“迟到 N 天送达”；N 按完整 24 小时向下取整。
  实际收到时间取本机处理解密消息时的设备时钟，不采用 rumor 的时间。自报时间可倒填、设备时钟也非可信时间戳；
  异议只供协商，不改变余额。重复异议保留首次接收结果与送达时间，不因重放重新计算。
- 时间是设备本地时间，只保证不倒退，不保证可信时间戳。
- 异议只做标记，不改变余额；老师同意后另记 `refund`（L1/L2）。
- 计价只在老师资料里声明（`declarePricing`），账本只记整数康币，不记真实货币金额。

## 测试

`ledger.test.ts` 覆盖任务卡 M1-14a 的 8 条验收用例，另加两条结构测试：
记账链单一写入者（学生提异议后老师继续记账，链不分叉）与异议目标必须是链里已存在的扣费。
全部使用合成公钥、整数金额与合成时间轴。

账本规则（事件类型、L1/L2/L3、P7）属于 C 类，改动须经发起人确认；本目录不自行修改规则。
缓存防护：重算 id 后逐字段构造全新事件再验签，避免对象展开携带 verified Symbol；只改 sig 的回归测试必须失败。

## M1-14b 同步与界面

每个身份只启动一个 createLedgerSync 控制器（当前 M1 不支持多标签同时写同一本账）。
先 open(teacher, student) 显式登记本人参与的账本，双方各登记一次；未登记的来信不创建账本。
record 供后续老师本人确认记账的界面调用，dispute 供学生本人提出异议的界面调用；本卡没有自动记账、AI 签字或支付。

- ledger.event / ledger.dispute 的 payload 是原始签名事件；外层 Envelope.version 为 1。
- ledger.sync 请求 payload 为 {teacher, student, length, head}；回复另带 events、disputes、receipts。
  receipts 为 {id, receivedAt, status, delayDays, message}，用于异议入列确认或拒收说明，不参与记账链/余额。
  学生未获确认的异议在 pendingDisputes；只有老师接收后才进入已接收列表。
- 签名、角色、师生标签、时间、prev 和现有 L1/L2/L3/P7 校验均复用 verify，逐项校验；不更改 chain.ts、verify.ts 或 types.ts。
- 本机变更与待发信封放在同一条加密记录中提交，成功落盘后才发送；重启重试待发队列。
  中继 ACK 仅表示包裹被保存；不保证对方已读取，双方打开/重连时再整本对账。
- 学生只补齐有效链的连续后缀；断序单条消息先请求完整快照。无效快照不入账，但可检出已验签的分叉证据。
  老师不从学生快照自动恢复自己缺失的账，双方均不选择分叉分支、不覆盖已有历史。
  对方缺项、无效数据、本机链异常均显示本地提示；分叉证据持久化且余额和对账码隐藏。
- 打开应用、恢复前台、网络恢复、中继重新鉴权、收到 SW 唤醒均请求对账。
  SW 推送仍只显示固定文案，不读取推送载荷；仅通过同源固定消息唤醒已打开页面。
- 设置的“康币账本与对账”展示列表、异议、提示和“余额 · 链尾哈希前 6 位”。
  中继地址复用备份设置的加密 backup-config.relays，未保存时使用 VITE_COMMUNITY_RELAYS。
  恢复备份前关闭同步并等待已排队写入完成，恢复成功或失败后重新开启；保存中继配置也重新连接。

持久化集合见 ../store/README.md。账本不会裸发给中继；所有信封经现有 NIP-17 礼物包裹端到端加密。
M1 采用全本快照，受传输层 2MiB 信封上限约束；超出时待发记录保留并显示失败，后续需另卡分片。
提示保留为本地历史，不随较晚快照自动清除；冲突需师生人工核对，本卡未提供清除/修复按钮。
本卡没有新增依赖，没有真实中继/两部实体手机的验证，也不宣称能检测双方同时丢失的相同尾部记录。

sync.test.ts 使用两套 createTransport、鉴权内存中继和独立 fake-indexeddb，覆盖任务卡 7 项及
持久去重、队列重试、乱序补齐、角色边界、接收时间/24 小时边界与生命周期清理。
