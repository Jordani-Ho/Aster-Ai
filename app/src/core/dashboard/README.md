# core/dashboard · 社区统计与只读仪表盘

V2-14：每座馆每天只交计数与时长，走现有 NIP-17 传递层。这里没有服务器接口，也不读病历内容。

## 一天一条信封

- 信封：`{ type: 'community.stats', version: 1, payload: DailyStats }`，发给部署 `.env` 里的 `DASHBOARD_PUBKEY`。
- 触发：老师打开应用、中继就绪时；开关开（默认）、`DASHBOARD_PUBKEY` 与 `DASHBOARD_URL` 都填了、今天还没发过，才发一条。
- 本馆 ID：`settings/dashboard-hall-id` 随机 16 位十六进制，不是公钥、不是名字，只用于仪表盘区分馆。
- 开关：`settings/dashboard-share`，默认开；关掉后 `sendDailyStats` 直接跳过。
- 昨天已发过：`settings/dashboard-last-sent` 只记日期。

## 字段口径

`version`（统计格式版本）、`appVersion`（`app/package.json` 版本）、`hallId`、`date`（本地日期）、
`onlineSeconds`、`errorCounts`（只记 uncaughtError / unhandledRejection 次数）、
`consults`（本机 `consult-package` 中 receivedAt 为今天的条数）、
`signatures`（`teacher-records` 中 createdAt 为今天的条数）、
`avgSignMinutes`（同一天签字记录 createdAt 与对应问诊 receivedAt 的分钟差平均，1 位小数；没签字为 null）、
`homeworkCheckins`（当天收到的问诊里学生坚持率趋势中今天的打卡数之和；没有数据为 null）、
`tongueRecords`（当天问诊包里的舌头记录条数）、
`students`（`teacher-students` 名单人数）。

- **服务在线时长** = 本机应用当天累计开着的秒数（`session.ts`，每次打开从当天已有累计续上）；打开应用时发当天统计，所以是本次打开前累计 + 本次已开几秒。没有记录时为 0。
- **数据不足留空**：签字平均用时、作业打卡数在无数据时为 `null`，仪表盘显示“—”，不编 0。
- **永不进统计**：病历字段内容、舌象内容/图片、钱账、学生本人感受（`kangbi-self` 一律不读）、名字、城市、IP、任何公钥（信封收发双方除外）。

## 只读仪表盘

- 同一个单页应用的 `/#dashboard` 路由，静态页，不新增后端。最近 30 天按 `hallId` 分组显示。
- 查看者私钥只在浏览器本地：URL 带 `#dashboard=<私钥>` 读一次后放 sessionStorage 并从地址栏移除；没有钥匙时不显示任何数据。
- 页面上没有按钮、表单、链接，也不能改馆/设置/发消息（测试断言）。
