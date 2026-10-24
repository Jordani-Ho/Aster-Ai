# V2-28 建馆傻瓜化与实测小问题

- 状态：待派（**DeepSeek**，可与 Codex 的卡并行）
- 依据：`team/founder-selftest-log-2026-10-23.md` 第一节 11 条；决策 2026-10-23（建馆该给选择的给选择，口令已复制要提示）
- 原则：每一处发起人来问过的地方，都改成不用问人就能过。

## 范围

1. **口令**：输入框自动去掉前后空格和换行（实测多了一个字符就 403）；页面直接写明口令在哪里、为什么要有、用过就作废。生成或复制口令后提示“口令已复制，直接粘贴到下面的框里即可，不用自己编”。
2. **接入模型**：给选项（DeepSeek、Kimi、千问、其他），选了就自动填好接口地址和模型名；连不上时分清是“密钥不对”“账户没额度”“网络不通”，各说一句怎么办。
3. **学生端少填 Key**：部署开了社区网关模型时，学生先用网关模型直接开始，以后想换再填自己的 Key；手机上不用再从电脑传 Key。
4. **无痕窗口底部按钮看不到**：底部按钮区按安全区和视口高度固定，iPhone 15 Pro、华为两种宽度都要看得到。
5. **照镜子**：“已保存舌象裁剪图…”这句提示放到拍照区，不要出现在“今日作业”卡里。
6. **问诊页**：舌象区里的“居住城市”选择去掉（城市改由 V2-23 的基础信息提供）。
7. **部署**：更新环境时不能清空成员名单（实测把 `members.json` 删掉重生成了空名单，邀请因此失效）；WSL 保活和固定隧道写进 `docs/内测怎么开始.md`。

## 验收用例

1. 口令前后带空格和换行粘贴：登记成功。
2. 选 Kimi：接口地址和模型名自动填好；密钥错时提示“密钥不对”。
3. 开了网关的部署：学生不填 Key 也能走到首页。
4. 无痕窗口、iPhone 15 Pro 与华为宽度：底部按钮可见可点（截图）。
5. 跑一遍更新脚本：成员名单不变，旧邀请仍有效。
6. CI 三项全过。

## 完成记录（2026-10-24）

- PR：https://github.com/Jordani-Ho/Aster-Ai/pull/62（分支 `task/V2-28-open-hall-foolproof`，未合并）。
- 口令：输入框粘贴即去掉所有空格/换行/制表符（`normalizeSetupToken`，`app/src/core/onboarding/index.ts`），登记前再兜一次；第 2 步写明口令在 `deploy/home/data/teacher-setup-code.txt`、是一次性引导凭据（证明你是服务器主人、防抢注老师）、用过就作废；`setup.sh` 生成后提示“复制后直接粘贴，不用自己编”。
- 接入模型：建馆第 1 步给 DeepSeek / Kimi / 千问 / 其他 四个选项，选预置服务商自动填好接口地址与模型名并显示；连接失败分档为“密钥不对 / 账户没额度 / 地址或模型名不对 / 服务商没响应 / 网络不通”，各一句怎么办（`connectionError`）。
- 学生少填 Key：部署配了上游模型时 `setup.sh` 写 `COMMUNITY_MODEL=1`（`compose.yaml` 注入 `VITE_COMMUNITY_MODEL`）；学生端出现「先用社区模型开始」，先试一句再记本机标记 `settings/community-model { mode:'gateway' }`，不用自己的 Key；接入自己的模型后标记清除、以个人模型为准。模型请求仍走网关 NIP-98，不新增接口。
- 底部按钮：欢迎首屏（`.sf-welcome` 100dvh + 内容区滚动 + 底栏含安全区）与首次接入模型页（`.model-start` 同结构）底部按钮固定在视口底；无痕短窗口 780×500 与 iPhone 15 Pro 393×852、华为 412×915 / 448×924 都可见可点（`e2e/v228.browser.mjs` + `docs/screenshots/v228-*.png`）。
- 照镜子提示：`已保存舌象裁剪图…` 从“今日作业”卡移到“照镜子”卡（`StudentToday.tsx` 新增 `mirrorStatus`，打卡提示仍在作业区）。
- 问诊页城市：舌象区不再有“居住城市”下拉（`TongueCapture` 删除选择器）；仍读取现有 `profile.city` 兜底，没填时提示去「我 → 我的时间」选。依赖 V2-23 的基础信息提供城市（Codex 的卡，尚未落地，本卡未改其代码）。
- 部署更新：新增 `deploy/home/update.sh`（备份 → 重新生成配置 → 按需重建重启 → 核对名单人数与口令没变）；新增 `scripts/safeguard-data.mjs`，`setup.sh` 与 `update.sh` 都会先备份到 `data/backup/last/`，成员名单/口令种子被误删或清空会先恢复；不会再靠人记得别删文件。`docs/内测怎么开始.md` 补 WSL 保活（任务计划程序 + 电源命令，整机重启验证）、固定隧道（Cloudflare 命名隧道）与更新步骤；`deploy/home/README.md` 同步。
- 验证：`app` 61 文件 / 453 测试；typecheck / build / typecheck:e2e 通过；`e2e/deployment.test.mjs` 6 项通过（含误删恢复、更新脚本名单/口令不变、`COMMUNITY_MODEL` 开关）；`e2e/v228.browser.mjs` 全 PASS（Kimi 自动填 + 密钥错、口令去空白且请求里 token 干净、社区模型免 Key 进首页、4 种视口底部按钮可见、网关 503 时明确提示）；`tongue.browser.mjs`（两内核 + 城市兜底场景）、opening / phone / abstractor / storefront 浏览器回归全 PASS。
