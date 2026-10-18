# M1-15b 端到端验收与试点指标

V2-03：`node e2e/abstractor.browser.mjs` 独立启动本机 Vite + Chromium，不需中继/Rust；使用实际镜子与问诊组件、普通 IndexedDB、真实 inbox 收件，视觉模型为合成替身，覆盖重拍失败、重载、家人隔离、草稿与发送、文件输入清空及所有业务记录无原图。CI 也运行。完整 `flow.spec.ts` 已改成发送抽象舌象；面诊测试断言不再有原图拍摄入口，签字/作业/账本/CSV 路径保留。

这里只运行合成身份和资料。M1-15a 合并后接入完整九步问诊与四条硬性验收，使用真实编译中继、真实网关和 Chromium；模型与推送为本地替身，不需要 API Key。

## 一条命令

在仓库根目录运行 `npm run e2e`。缺 JS 依赖时从根、app、gateway 三个 lockfile 安装，缺匹配 Chromium 时下载；已预装时复用 `PLAYWRIGHT_BROWSERS_PATH`。命令编译/校验中继、启动网关及 Vite、运行全部浏览器测试，退出时关闭监听器/中继并删除本次数据库、名单、订阅与日志。每条测试先通过带随机令牌的 loopback 控制接口重启真实中继并换空数据库；浏览器上下文独立，worker 固定为 1。

前提：Node >=22、Git、Linux C/C++ 工具链、CMake、Python 3、Rustup 的 **Rust 1.90.0 minimal**。Ubuntu 安装 `build-essential cmake pkg-config python3`，运行 `rustup toolchain install 1.90.0 --profile minimal`。没有系统 protoc 时脚本私下下载 **protoc 31.1**（2025-05-28，BSD-3-Clause），验证固定 SHA256 后用 Python 标准库解压。`E2E_PRIVATE_PROTOC=1` 强制此备用路径（CI 使用）；非 x64 Linux 请自行安装 protoc。缺 Chromium 系统库时运行 `npx playwright install --with-deps chromium`。

Windows 使用已有 **Ubuntu/WSL** 编译并运行中继，Node/Chromium 使用 Windows 原生。WSL 也需 Node >=22 和上述工具，通过 localhost 转发连接。控制管道负责结束 Linux 内真正的中继进程。WSL 缓存放 Linux 用户目录 `.cache/aster-e2e/仓库路径摘要`，避免 /mnt/c 小文件开销。可选私有 Rustup 位于仓库 `.cache/e2e/tools/cargo/bin/rustup`，RUSTUP_HOME 为 `.cache/e2e/tools/rustup`，无需修改 Windows PATH。macOS 原生本轮未验证。

## 固定版本与缓存

- `@playwright/test@1.58.2`，Apache-2.0，npm 发布时间 **2026-02-06T16:42:52.725Z**，距施工日 2026-10-17 超过 14 天，根 lockfile 固定依赖树，匹配 Chromium revision 1208。
- 沿用 relay/Dockerfile：MIT 的 nostr-rs-relay 0.10.0，固定提交 `b5c1f642e4f4c3b9c54f5d18d66f4c53642076b4`，依次应用 community-policy.patch、onboarding-policy.patch，`cargo build --release --locked`。不用替身或预制中继。
- Linux/CI 的 `.cache/e2e/relay/<指纹>/` 保存二进制和成功 manifest，指纹包含上游、补丁、构建脚本、rustc 信息、protoc 版本、系统/架构。命中重算二进制 SHA256，失败不生成可用 manifest。CI 缓存二进制、Cargo 下载与私有 protoc，并在浏览器测试前保存成功构建。
- CI 冷构建实测约 3分54秒、5分30秒，缓存约0.1秒；Windows/WSL 首次成功构建约20分44秒（Cargo20分15秒），缓存约2秒。下载/磁盘/核数会改变耗时，默认两条编译任务。`npm run e2e:build-relay` 可单独编译。强制结束后若残留 build.lock，确认编译进程结束再删除锁目录。

## 验证覆盖

`npm run typecheck:e2e` 用 app 已有 TypeScript 检查测试编排；`npm run test:e2e-env` 的5项合同测试覆盖真实 gateway 的 NIP-98/成员校验、合成 JSON/SSE、不回显输入、推送注入与清理，以及真实 Vite 代理保留签名 Host。

`environment.spec.ts` 的4条探针覆盖自动生成身份的隔离与持久化、真实 NIP-42/NIP-17 往返、关闭模式下非成员拒绝与开放模式下任意已认证连接/匿名订阅拒绝、浏览器经同源代理访问网关。

`flow.spec.ts` 的4条用例覆盖：

1. 完整九步：文本、合成 JPEG、三轮追问、发送、老师模型起草/修改/采用/签字/扣费、学生病历/作业/打卡、随后复诊附上次病历。初始充值10仅为 fixture 通过原有账本接口准备，扣费3由真实签字界面触发，没有支付替身界面或改规则。
2. 硬性断言：老师端解密扫描全部 IndexedDB 业务记录，原话和处理后照片字节/base64不存在，重连重放后仍不存在；双方实际显示余额7与相同对账码；另一路先送篡改病历再送有效病历，学生只显示有效者。
3. 独立急症用例中断采集，不出现发送按钮，老师端无问诊包。

老师设置本机下载CSV，验收数值、短id、无原文/身份以及导出无HTTP请求；仅非CI运行写入忽略目录 `.cache/e2e/pilot-synthetic-local.csv`，供人工检查。指标公式/重试边界见 `app/src/core/pilot/README.md`。CI不保存CSV，也不上传浏览器报告、截图或trace；本机报告在 `playwright-report/`，失败附件在 `test-results/`，均不入库。CI缓存路径只包含编译/下载工具。

模型固定返回合成字段，不回显请求，不访问外网模型；推送经 gateway 已有 config.push.send 注入，不调用云推送。中继 RUST_LOG=off 且不收集stdout/stderr。应用源码经Vite运行，生产build另做检查；真实手机、生产部署、真实模型质量不在本轮范围。

Playwright 编排与安装参考[官方CI文档](https://playwright.dev/docs/ci)、[浏览器文档](https://playwright.dev/docs/browsers)。

## M1-17 邀请入口

fixtures现在先让老师自动生成身份、回答角色问题，用合成部署口令登记种子成员，再实际生成邀请链接；第二个上下文直接打开邀请，学生不输入任何资料。所有后台身份仅在测试里读取用于断言，不注入生产身份或绕过签名。初始10康币仅测试前提，通过暂停共享账本后用既有接口准备，重新打开共享连接后同步；实际扣费仍老师按钮触发。

完整九步只保留一条（页面自动生成身份），并保留原硬验收和本机CSV无上传断言。另测一问进入老师首页、可见文字无技术词、零输入学生登记、过期/非成员失效、开放模式与匿名边界。关闭模式仍跑原非成员AUTH拒绝。

`npm run test:deployment` 在隔离目录使用假的Docker命令验证现有setup重跑保留成员/口令和配置默认关闭，不调用真实Docker或Tunnel。CI中 `npm run e2e:test-relay` 在固定上游和两个补丁下跑原Rust全套测试（含CLI、连接与集成）。手机真实同步、外网Tunnel和生产部署本轮不代替验收。

私有Rustup同时显式指定RUSTC与RUSTDOC，`e2e:test-relay`保留各测试目标摘要，避免漏掉文档测试。M1-17本机已跑原有与新增Rust测试，零失败、零忽略。

M1-20：完整九步改用今天→远程→打开问诊→整卡改稿→签字发出，保留真实中继、网关、账本/销毁/本机 CSV 的原硬验收。teacher.spec.ts 新增急症在两列表排首位、三次点按签发（改稿输入/提交不计）、改方仍为 AI 草稿且签后无 ai_draft、签字时零模型请求、面诊对话起草/改稿/交还后原文草稿删除。仅使用合成资料与固定模型替身，不能代替真实模型理解能力验收。非 CI 时生成四张 375×812 截图到 docs/screenshots/teacher-*-375.png；CI 不上传截图、原文或 CSV。老师镜子、方案签发和次日时钟用例已随 M1-18 接入补齐。

M1-18 接入后新增真实中继 care.plan 签发与学生次日镜子、老师自用镜子的浏览器用例；另有 fake-indexeddb 集成用例用固定 2026-10-17/18 测同日缓存与次日引用。浏览器鉴权阶段保持服务器当前签名窗口，跨日后保留网关时钟校验，错误时走 M1-18 原有建议回退，不放宽 NIP-98/NIP-42。

面诊用例现包含真实 Canvas JPEG：老师处理、签字并经真实中继交还，学生本机保存且 img 完成解码，同时老师附件与面诊草稿为空。额外集成测试覆盖照片先于病历、改图/改签名/陌生发件人拒收、缺照片不先发病历、失败保留原件与同一签名重发。

M1-21：teacher/student 前置都经真实接入表单测试并保存合成账户，再进入首页；模型请求由浏览器路由到本机固定替身，无真实凭证或计费。新增 model.spec.ts 验证初次门槛、401/402/网络中文错误、改字段作废测试结果、直连失败走真实成员签名代理、后备提示与关闭后固定问句。代理测试仅注入上游发送函数映射合成 URL，鉴权/限流/转发由真实网关执行。
