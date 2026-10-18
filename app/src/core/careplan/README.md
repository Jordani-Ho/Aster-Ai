# 调养方案（M1-18）

老师给学生定制调养方案，是学生「镜子」页个性化建议的来源。方案 `{constitution, points, avoid, updatedAt, version}` 由老师签名为 kind 2731 的 Nostr 事件，经中继信封 `care.plan` 发给学生；学生端只接受「我的老师」名单里签发的，按版本替换旧版。

- 签名/验签与 `record/sign` 的 kind 2730 同一套约定：先重算事件 id 再验签（E-004），事件经 JSON 往返后落盘/进信封（E-005），签字路径不调用模型。
- 存储集合 `care-plans`（键为老师公钥），AES-GCM 本机加密，登记在 `store/README.md`。
- 本模块只做签发、验签与存取；收件的「我的老师」白名单过滤在 `core/inbox` 里做。

M1-20 的 issue.ts 只编排以上 M1-18 函数，不另写签名或信封协议。真人确认时构造版本/时间、signCarePlan，先落 care-plan-pending，sendCarePlan 成功后只留 care-plan-issued 索引并删暂存；失败 retryCarePlan 重发同一事件。老师给自己的方案通过同一签名/验签流程后存入本人 care-plans，无需发给另一个收件人。起草在 ../drafting/careplan.ts，签发模块不得导入它或 llm。
