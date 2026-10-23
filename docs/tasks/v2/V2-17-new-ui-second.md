# V2-17 新界面第二批：建馆、学生、我的馆，学生进馆、问诊、记录、我

- 状态：已派（DeepSeek，接在 V2-16 之后）
- 依据：设计稿 `docs/design/05a–12-*`（Codex 出稿，PR #54，技术合伙人审过；每屏排版理由见 PR #54 说明）；决策 2026-10-22“界面由使用者说了算”
- 原则：同 V2-16。只重做界面层，`core/` 不动；这些页的旧界面整块删，不留开关；字体用系统字体栈，不加载 Google Fonts

## 范围（一页对一张稿）

**老师端**
- 05a–05e 建馆五步：替换 V2-15 的引导界面，逻辑沿用 V2-15（断点续走、第一个邀请 1 小时、“先进去看看”）。
- 06 学生：名单、搜索、“全部 / 最近来过”筛选，每行标坚持情况；没打卡的标出来。
- 07 一位学生：当前方案、本周坚持、历次病历、钱账，底部“开始面诊”直接进 V2-16 的面诊页。
- 08 我的馆：馆卡片、“邀请学生”主按钮、门面、钱账总览、设置（保留期限、换手机、运行统计、模型收在里面）。

**学生端**
- 09 进馆首屏：替换 V2-09 的邀请首屏。
- 10a–10c 问诊：说一说 → 再问一句（可跳过）→ 看一眼问诊卡片再发出；10d 急症时：顶部“请尽快去医院”，**不拦截**，仍可发给老师（医纲第二·一条）。
- 11 记录：我的病历、舌象的变化、坚持的趋势。
- 12 我：我的老师（多馆切换）、家人、在老师这里的余额、设置。

## 验收用例

1. 每页 375px 截图和对应设计稿并排贴进 PR。
2. 老师：全新部署走完建馆五步；从“学生”进一位学生，点“开始面诊”能直接开始。
3. 学生：从邀请链接进馆 → 首页 → “不舒服？告诉老师”→ 三步发出；说到急症信号时出现提醒、仍能发出。
4. 旧页面组件（旧管理页、旧邀请首屏、旧问诊页、旧“其他”页）在代码里搜不到。

## 完成记录（2026-10-22）

- 分支 `task/V2-17-new-ui-second`；页面：`TeacherStudentsPage`（06+07）、`TeacherManagement` 重画（08）、`OpeningGuide`（05a–05e）、`StorefrontWelcome`（09）、`ConsultPage`（10a–10d）、`StudentRecordsHome`（11）、`StudentMe`（12），`TeacherShell`/`StudentShell` 接上；`TeacherCarePlan` 签发后写本机 `care-plan-snapshot` 供 07 显示当前方案（只存本机、不进协议）。
- 单元测试：新增 `teacher-students.test.ts`（排序/搜索/最近来过/本周三档）与 `records-trend.test.ts`（近四周趋势）共 6 项。
- 浏览器验收：`phone.browser.mjs` 覆盖 05a–05e 逐页截图与完整建馆、06→07→开始面诊、09→问诊三步、11、12，并保留 V2-16 回归，15 张 375px 截图写入 `docs/screenshots/`；`opening.browser.mjs`、`storefront.browser.mjs`、`abstractor.browser.mjs`、`money.browser.mjs` 全 PASS；`e2e` typecheck、environment/deployment 合同测试通过。
- 真实中继 Playwright：本机 WSL 装 Rust 1.90 后编译 relay，28 条用例全过（environment 4、flow 4、model 4、money 1、onboarding 3、opening 4、phone 5、teacher 3）。修复了 CI 暴露的一处真实回归：我的馆→钱账明细没把 `llm` 传给 `LedgerSettings`，「生成记账草稿」一直灰着；同时给问诊三步 e2e 的“跳过，直接整理”加了显式等待，避免慢机上误判。
- 与稿子的已知差异（均为数据口径）：名单没有逐日打卡，只能按学生上报的周汇总显示“本周还没打卡 / 本周 X/7”，不逐日推断；07 当前方案取本机签发快照，core 不存学生方案正文。
- CI：本机真实中继 28 条全过；CI app/gateway/e2e 三件套全绿（e2e 含真实中继 28 条）。

## 审核回改（2026-10-23，心理援助热线也删掉）

- 问诊三步顶端常驻一句「急症请立即去医院或拨打当地急救电话，别等老师回复。」，不管是否命中；命中急症/自伤都不弹窗、不拦截，发送按钮照常「发给X老师」。
- 删除 `app/src/RedFlagAlert.tsx`、`.redflag-*`、`.cf-emergency*` 样式、`contactsForAlert`/`getContact`/`detectRegion` 及其单元测试；老师面诊页的自伤热线分支一并删除。`domain/tcm/red-flags.json` 的规则与联系方式数据属于已审 C 类数据，保留但不再被任何界面/代码读取。
- 用例：`e2e/flow.spec.ts` 的「emergency wording only shows the standing hint…」与「self-harm wording looks normal…」；`e2e/phone.browser.mjs` 的 10d 与自伤场景。断言常驻提示存在、无 `role=alert`、无 `.redflag-notice`、全页无「心理援助热线/24小时热线/热线/12356」与常见急救号码、发送可用且能发出（问诊包仍带 redFlag）。
- grep 证据：`git grep -n "RedFlagAlert\|contactsForAlert\|getContact\|detectRegion" -- app/src e2e` 为空；`git grep -n "心理援助热线\|24小时热线\|仍发给\|你并不孤单" -- app/src` 为空（测试里只保留“不得出现”的断言字符串）。
