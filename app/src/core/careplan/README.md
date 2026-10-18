# 调养方案（M1-18）

老师给学生定制调养方案，是学生「镜子」页个性化建议的来源。方案 `{constitution, points, avoid, updatedAt, version}` 由老师签名为 kind 2731 的 Nostr 事件，经中继信封 `care.plan` 发给学生；学生端只接受「我的老师」名单里签发的，按版本替换旧版。

- 签名/验签与 `record/sign` 的 kind 2730 同一套约定：先重算事件 id 再验签（E-004），事件经 JSON 往返后落盘/进信封（E-005），签字路径不调用模型。
- 存储集合 `care-plans`（键为老师公钥），AES-GCM 本机加密，登记在 `store/README.md`。
- 本模块只做签发、验签与存取；收件的「我的老师」白名单过滤在 `core/inbox` 里做。
