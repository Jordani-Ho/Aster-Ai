# 康币账本核心

`M1-14a` 的纯逻辑账本（技术白皮书 §8.2）：每种事件由签发人用 Schnorr 签名，按顺序引用上一条
事件的哈希，形成哈希链。本目录不联网、不依赖界面；两端同步与对账属于 M1-14b。

## 事件

一条账本事件就是一条 kind `2729` 的 nostr 签名事件（内部类型，不与已用 kind 冲突），
content 是账本字段的 JSON，`tags` 里绑定这本账的（老师公钥，学生公钥）。
哈希链的“上一条哈希”就是上一条 nostr 事件的 `id`（sha256 事件摘要）。

- `topup` 充值：老师签，金额、付款方式说明（可选）。
- `gift` 赠送：老师签，金额、说明。
- `charge` 扣费：老师签，金额、事由（`consult` / `herbs` / `other`）、关联签字病历或药材清单哈希（可选）。
- `refund` 退款：老师签，金额、针对哪条事件（可选）。
- `dispute` 异议：学生签，针对哪条 `charge`、一句话理由。

签名用已批准的 `nostr-tools@2.25.2` 的 `finalizeEvent`，不自造签名算法。

## 余额与欠费

- `balance(ledger)` = 充值 + 赠送 − 扣费 − 退款；异议不影响余额；允许为负（L3）。
- `overdueSince(ledger)`：返回“余额从某个时间点起一直是负数”的起始时间。账本末尾余额不为负时返回 `null`；
  余额回正后再次转负时，返回后一段连续欠费的起始时间。

## 校验

`verify(ledger)` 返回问题列表（`{ index, code, message }`），空数组表示通过。逐条检查：

- `wrong-kind` / `bad-signature`：kind 正确、事件 id 与 content 一致、Schnorr 签名有效；
- `wrong-tags`：事件绑定的是这本账的师生公钥；
- `wrong-issuer`：充值/赠送/扣费/退款只能老师签，异议只能学生签；
- `broken-chain`：`prev` 等于上一条事件的 id（第一条必须为 `null`）；
- `time-regressed` / `created-at-mismatch`：时间不倒退，且与 nostr 的 `created_at` 一致；
- `invalid-amount`：金额必须是正整数（异议不带金额）；
- `invalid-reason` / `invalid-record-hash`：扣费事由与关联哈希格式；
- `refund-exceeds-topups`：L2，退款金额不得超过“累计充值 − 累计退款”（按事件顺序累计到该条）；
- `unknown-refund-target` / `unknown-dispute-target`：引用必须指向之前存在的事件，异议必须针对之前的扣费；
- `dispute-too-late`：P7，异议必须在扣费后 7 天内（含第 7 天，按事件时间计算）；
- `missing-reason`：异议必须写一句话理由。

注意：`nostr-tools` 的 `verifyEvent` 会在事件对象上缓存“已验证”，展开复制会把这个缓存带过去；
因此 `verify` 先用 `getEventHash` 重算事件 id，再验签名，避免被缓存绕过。

## 已知边界

- 哈希链能发现内容被改、中间事件被删，但**发现不了账本末尾被截断**；这需要 M1-14b 的师生两端副本对账。
- 所有金额事件都由老师签发，老师理论上可以重写自己的历史（连同哈希链），但改不掉学生签名的异议；
  两端各存一份、互相对账才能发现分歧。
- 时间是设备本地时间，只保证不倒退，不保证可信时间戳。
- 异议只做标记，不改变余额；老师同意后另记 `refund`（L1/L2）。
- 计价只在老师资料里声明（`declarePricing`），账本只记整数康币，不记真实货币金额。

## 测试

`ledger.test.ts` 覆盖任务卡 M1-14a 的 8 条验收用例：余额、篡改与删除检测、签发人身份、7 天异议、
L2 退款上限、`overdueSince`、非法金额、以及只使用合成公钥与整数金额。

账本规则（事件类型、L1/L2/L3、P7）属于 C 类，改动须经发起人确认；本目录不自行修改规则。