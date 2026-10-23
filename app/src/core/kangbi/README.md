# 康币观察地基（V2-04）与三方观察（V2-10）

生产规则在 `domain/tcm/kangbi-rules.json`，所有数值均为 null；权重只有 `teacher` 与 `measurement`（V2-10 去掉了 `self`：本人感受不进康币）。没有康币自动写账或余额显示入口；没有充值购买康币、币种换算或对外连接实现。`KangbiEvent` 定义 create/flow/decline，`KangbiExternalConnection` 仅为未来发布汇总的类型口。

## 观察记录（`kangbi-observations`）

V2-10 起一条记录是：`{周期起止 periodStart/periodEnd, practiceDays 有效坚持天数, teacherMinutes 老师分钟, consultations, teacherNote 老师一句, agentNote 智能体一句, effects:{teacher,measurement} 客观量表}`。
`teacherNote`/`agentNote` 是 `improve|same|worse|unsure|null`，null 表示未评价，**不是持平**；都不含病历内容、照片或本人感受。

- 观察周期：一位学生跟一位老师，从上次签字到这次签字；第一次从学生加入那天算起。老师端 `teacherObservationWindow` 用本机上次签字的病历（排除本次刚签的），第一次用学生第一次问诊到达本机的时间；学生端 `studentObservationWindow` 用本机收到的上一位老师签字病历，没有就用 `settings/joined-at`（邀请加入时记）。
- 老师一句在核对签字页选（`SignReview.tsx` 的“和上次比”四选一），不选记 null。
- 智能体一句由**学生智能体**在发送问诊时算：`domain/tcm/observation-rules.ts` 的 `agentObservation`，规则数值在 `domain/tcm/observation-rules.json`，不看模型。数据不够（有效坚持天数 < 3 或没有坚持率）一律“说不准”；坚持率与舌象方向冲突也“说不准”。结果作为 `PeriodObservation` 随问诊包发给老师（只有计数与一句话）。
- `recordSignedObservation` 在签字成功后写记录（老师端，远程与面诊都写）。

旧的 V2-04 记录（没有周期与两句话、`effects` 里有 `self`）仍能读：`normalizeObservation` 只在读时归一（周期取 `at`、两句话 null、丢掉 self），**不重写盘上数据、不做数据迁移**。

## 本人感受只在本机（`kangbi-self`）

学生在镜子页“这段时间自己感觉”四选一，写本机集合 `kangbi-self`：`{id, student, teacher, at, choice}`。
它不随问诊包发出、不进任何信封、不进老师端观察记录；老师端看不到。存储与读写只在 `core/kangbi` 的 `recordSelfObservation` / `latestSelfObservation`，出站模块（inbox/transport/wiring/records.backup/reidentify/careplan）不引用这个集合。保留期清理不碰它（长期留在这台手机上）。

## 影子试算 `shadowRun`

`shadowRun(observations, candidateRules)` 是**只读纯函数**（不接受 store，不写任何记录、无界面入口）：同一批观察在候选规则下“如果启用，每人多少刻”。
输出 `perStudent`（每人 create/flow/decline/net）、`totals`、`distribution`（按 `bucketSize` 分桶的 net 分布）与 `skipped`（规则不全/客观量表为 null 而算不出的条数，不能当零）。生产规则全 null 时全部 skipped、总量为 0。它按单条观察逐条计算，不累计跨日上限（上限仍逐条应用），只给技术合伙人做发起人摘要用。

## 其他

`kangbiSummary` 对外只给人数、观察次数、天数、分钟数与老师/测量两列的计数/合计，不返回名字、公钥、原记录、评语或个人明细。`kangbi-observations` 是本机个人观察记录，**长期保留、不受保留期限影响**（V2-05 起列入长期集合：只有计数与评语，没有内容，是将来给康币定值的依据）。钱账不导入本模块，观察数据不产生钱账交易。
