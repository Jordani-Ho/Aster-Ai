# V2-31 老师登记不用手抄口令：扫码即登记；口令与网关永远一致

- 状态：待派（DeepSeek，小卡）
- 依据：发起人 2026-10-24 实测（无论怎么粘贴都 403，根因是 V2-28 更新脚本恢复了旧口令文件，而网关用的是新哈希）；决策 2026-10-20（老师端全在手机上用）
- 原则：老师在**手机**上建馆（身份生成在手机上），所以登记链接要能让手机打开；口令不经过任何服务器日志。

## 范围

1. **扫码登记**：`setup.sh` / `update.sh` 结束时，如果还没有老师登记过：
   - 在终端打印一个二维码，并生成一个本机网页 `data/teacher-setup.html`（只在部署电脑上打开），上面显示同一个二维码。
   - 二维码内容是部署网址加 `#setup=<口令>`。口令放在 `#` 后面，浏览器不会把它发给服务器，隧道和网关日志里都不会出现。
   - 老师用手机扫码：打开建馆引导，第 2 步自动填好口令，老师只需点“登记”。登记成功后应用立刻从地址栏清掉 `#setup=…`。
   - 手动粘贴的老路仍然保留（V2-28 的去空格照旧）。
2. **建馆第 2 步文案**：“在部署电脑上打开 `teacher-setup.html`，用这部手机扫码，口令会自动填好。”
3. **口令只有一个来源**：口令文件和网关种子不能各自恢复。改成：
   - `seed.json` 和 `teacher-setup-code.txt` 只能**成对**备份、**成对**恢复；只缺一个时，不恢复，直接重新生成一对（还没有老师登记时），或保留种子、删掉孤立的口令文件（已有老师登记时，口令已经作废）。
   - 每次 `setup.sh` / `update.sh` 结束都核对：口令文件的哈希必须等于种子里的 `tokenHash`，不等就报错退出，并说明怎么处理，不能带着不一致的状态启动。
4. **口令用过即作废**：老师登记成功后，删掉 `teacher-setup-code.txt` 和 `teacher-setup.html`。

## 验收用例

1. 全新部署：终端和 `teacher-setup.html` 都显示二维码；合成手机打开该地址后，第 2 步已填好口令，点登记成功，地址栏不再含口令。
2. 网关访问日志和隧道请求里找不到口令（e2e 断言）。
3. 只删 `seed.json` 或只删口令文件后再跑 `update.sh`：不会出现一新一旧；最终口令哈希等于种子，或在已有老师时口令文件已删除。
4. 人为改坏口令文件后跑 `update.sh`：核对失败、报错退出，不启动。
5. 登记成功后，口令文件和 `teacher-setup.html` 都已删除。
6. CI 三项全过。

## 完成记录（2026-10-24）

- PR：https://github.com/Jordani-Ho/Aster-Ai/pull/66（分支 `task/V2-31-setup-link`，未合并）。
- 扫码登记：`setup.sh`/`update.sh` 在还没老师登记时，终端打印二维码并生成 `deploy/home/data/setup/teacher-setup.html`；二维码内容 `https://<域名>/#setup=<口令>`。建馆第 2 步自动填口令，读到后立刻清掉地址栏 fragment；手动粘贴老路保留。
- QR 实现：内嵌 qrcode-generator 1.4.4（MIT，vendor 带 LICENSE，56,694 B，无 npm 依赖）；终端 ANSI 白底黑块与 HTML SVG 共用同一矩阵。
- 口令一致性：`scripts/safeguard-data.mjs` 把 seed 与口令当一对：成对备份/恢复；只缺一个时未登记就重生成一对、已登记就保留种子删作废口令；哈希不一致报错退出并给出处理命令；`setup.sh`/`update.sh` 结束跑 verify，`verify.sh` 也检查。
- 口令作废：网关在 `/invite/seed` 认领成功分支里删除 `data/setup` 的口令与 html（网关只多挂 `./data/setup:/app/setup`，无新接口）；setup/update 的 verify 兜底补删。`gateway-config.json` 新增 `setupDir: /app/setup`。
- 路径：口令/扫码页移到 `deploy/home/data/setup/`；README、`docs/内测怎么开始.md`、`docs/合伙人/落地手册.html`、`verify.sh`、`update.sh` 同步。
- 验证：app 64 文件 / 497 测试；gateway 29 测试；deployment 12 项（新增二维码与口令不外泄、成对规则、改坏退出、自测成员幂等补回、update 顺序 5 项）；新增 `e2e/v231.browser.mjs`（扫码链接自动填、地址栏清空、请求 URL 不含口令、手动粘贴老路）并加入 CI；opening/phone/v228/v229/storefront/abstractor 回归 PASS；真实中继 e2e 本机 28/28。真机扫码待内测确认（CI 无扫码解码能力）。
- 审核补充（gh #66 评论）：修了自测环境真实 bug——名单被重置成 0 人但 `data/self-member.json` 还在时，`verify.sh` 以前只在首次生成时写名单，导致“网关成员请求期望 202，实际 403”。现在 `ensure_self_member` 每次都幂等补公钥进 `data/gateway/members.json`（去重）；`update.sh` 顺序改为 prepare 恢复 → setup → verify 补成员并探测 → check 只核对，恢复不会覆盖 verify 补进去的成员；新增两条 deployment 断言覆盖这两种情况。
