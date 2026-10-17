# M1-15b 测试环境（阶段 1）

这里只运行合成身份和合成资料。当前交付是测试环境与冒烟探针；完整九步问诊、四条硬性验收、
试点指标采集/CSV 均等 **M1-15a 合并后**再接，当前通过不表示完整业务已验收。不使用 skip 或替身中继冒充完整流程。

## 一条命令

在仓库根目录运行 `npm run e2e`。首次缺 JS 依赖时从三个 lockfile 安装，缺匹配的 Chromium 时下载；
已预装时直接复用 `PLAYWRIGHT_BROWSERS_PATH`，未设置时用 Playwright 默认缓存。
命令会编译/复用真实中继，启动中继、真实网关、本地模型/推送替身和 Vite，再运行 Chromium。
结束或启动失败会关闭监听器/中继并删除该次临时数据库、订阅、成员名单与网关日志；浏览器报告在
`playwright-report/`，失败的合成数据截图/trace 在 `test-results/`。两者不入库，CI 仅保留 7 天。

前提：Node >=22、Git、Linux C/C++ 工具链、CMake、Python 3、Rustup 的 **Rust 1.90.0 minimal**。
Ubuntu 可安装 `build-essential cmake pkg-config python3`，再 `rustup toolchain install 1.90.0 --profile minimal`。
没有系统 protoc 时脚本私下下载 **protoc 31.1**（2025-05-28，BSD-3-Clause）并验证固定 SHA256，
用 Python 标准库解压，不要求 Docker、sudo 或全局安装 protoc。系统已有 protoc 则复用；
`E2E_PRIVATE_PROTOC=1` 强制验证备用路径（CI 使用此项）。非 x64 Linux 请自行安装 protoc。
Chromium 缺系统库时先运行 `npx playwright install --with-deps chromium`（CI 已做）。
这是构建环境前提，不在测试中绕过失败。

Windows 使用已有的 **Ubuntu/WSL** 编译与运行中继，其余 Node 与 Chromium 保持 Windows 原生；
通过控制管道关闭 WSL 内真实进程，避免只结束 wsl.exe 遗留中继。需要 WSL 的 localhost 转发。
WSL 的 Cargo/二进制缓存放 Linux 用户目录的 .cache/aster-e2e/仓库路径摘要，避免 /mnt/c 的大量小文件 I/O；
Linux 原生/CI 仍在工作区 .cache/e2e，方便 actions/cache。
WSL 内也需上述构建前提及 Node >=22；默认发行版固定为 Ubuntu。可选私有 Rustup 位于
`.cache/e2e/tools/cargo/bin/rustup`，对应 RUSTUP_HOME 为 `.cache/e2e/tools/rustup`；不要求改 Windows PATH。
macOS 原生构建不在本轮验证范围，可在 Linux/CI 运行。

## 固定版本与缓存

- 新开发依赖 `@playwright/test@1.58.2`，Apache-2.0，npm 发布时间 **2026-02-06T16:42:52.725Z**，
  距施工日 2026-10-17 已超过 14 天；版本和依赖树固定到根 lockfile。其 Chromium revision 为 1208。
- 中继沿用 `relay/Dockerfile`：MIT 的 nostr-rs-relay 0.10.0，提交
  `b5c1f642e4f4c3b9c54f5d18d66f4c53642076b4`，顺序应用 community-policy.patch、backup-policy.patch，
  `cargo build --release --locked`。不重写协议、不用内存中继、不下载未经本脚本编译的预制中继。
- `.cache/e2e/relay/<指纹>/` 保存成功编译的二进制与 manifest。指纹含上游、两补丁、构建脚本、
  Rust 编译器信息、protoc 版本及 OS/架构；命中时重算二进制 SHA256。失败不产生可用 manifest。
  Cargo 下载与中间产物也在 `.cache/e2e/`。CI 缓存成品和 crates 下载；改补丁/编译器会重新构建。
- 首次 release 构建可能数分钟至数十分钟（取决于下载、磁盘和核数），默认两条编译任务。
  脚本输出本次耗时及是否缓存命中；冷缓存 CI 两次实测 release 编译约 3 分 54 秒、5 分 30 秒，随后二进制缓存命中约 0.1 秒，完整结果见任务卡/PR。可用
  `npm run e2e:build-relay` 单独编译。被强行终止遗留 build.lock 时先确认编译进程已结束再删除该锁目录。

## 验证边界

`npm run test:e2e-env`：真实 gateway 的鉴权、成员限制、固定模型 JSON/SSE、推送注入与监听器清理。
`npm run e2e`：375px 的老师/学生独立浏览器上下文，合成助记词恢复及持久化隔离，
实际 NIP-42/NIP-17 加密往返，非成员拒绝，30078 本人备份/跨成员隔离，以及浏览器经同源代理访问真实网关。
环境合同测试还覆盖真实 Vite 同源代理保留 NIP-98 的签名 Host。
这些是基础设施探针，**不是完整问诊流程测试**。用的是应用现有模块和真实 WebSocket/HTTP，未给生产界面加测试后门。
网关仍用 gateway/server.js；模型在 loopback 固定返回合成起草字段，不回显输入、不调用真实模型，
不需要任何 API Key。推送通过已有 config.push.send 注入，不请求 FCM/APNs/任何云端。
中继 RUST_LOG=off，stdout/stderr 不采集；只存加密包裹与合成身份的加密备份。

未来在本目录新增 flow.spec.ts 与指标断言即可复用 fixtures.ts 的双身份上下文和同一真实环境，
不得因为尚未接线就把四条硬性断言改成跳过。试点 CSV 的生产代码本轮未实现，也没有向任何站点上传指标。
Playwright 编排与浏览器安装参考[官方文档](https://playwright.dev/docs/ci)、[浏览器文档](https://playwright.dev/docs/browsers)。
