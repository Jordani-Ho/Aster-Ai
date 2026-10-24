# V2-29 “跳过，直接整理”真的直接整理；界面显示版本号

- 状态：待派（DeepSeek，小卡）
- 依据：发起人 2026-10-24 实测（点“跳过，直接整理”后又出现下一条追问；截图显示他手机上跑的是 V2-20 之前的旧版本，但无从确认）

## 范围

1. **“跳过，直接整理”**：点了就结束追问，直接进“看一眼，再发出”的卡片页。剩下没问的项按“跳过”记（保持 `unknown`，不编造）。现在的行为是只跳过当前这一问、然后接着问下一问，这不对。
   - 另加一个“回答这一问”的按钮仍保留原来的逐问流程：“补充好了，整理卡片”提交答案后，如果还有要问的，继续问；没有就进卡片页。
2. **版本号**：在“我 → 设置”最下面和老师端“我的馆 → 设置”最下面，用小字显示当前版本（构建时写入的 git 短提交号和构建日期，例如 `cf9dc44 · 10-24`）。以后发起人实测时截图就能看出是哪个版本。

## 验收用例

1. 追问还剩 3 问时点“跳过，直接整理”：直接到卡片页，模型不再被调用追问；剩下 3 项在卡片上显示“未提供”。
2. 回答一问后点“补充好了，整理卡片”：还有要问的就继续问，没有就到卡片页（与现在一致）。
3. 两端设置页底部显示的版本号与构建时的 `git rev-parse --short HEAD` 一致（CI 断言）。
4. CI 三项全过。

## 完成记录（2026-10-24）

- PR：https://github.com/Jordani-Ho/Aster-Ai/pull/65（分支 `task/V2-29-skip-and-version`，未合并）。
- 跳过：`session.ts` 新增 `skipRemainingFocuses`（所有还没答的项记 skipped、清 questions、直接 confirm）；`ConsultPage` 的“跳过，直接整理”改调它，不调用模型；字段保持 unknown，卡片显示“未提供”。逐问流程（“补充好了，整理卡片”）保持原样。
- 版本号：构建时注入，优先级为“宿主机传进来的 `APP_VERSION`/`APP_BUILD_DATE` → 本机 `git rev-parse --short HEAD` + 当天 `MM-DD` → unknown”，经 Vite `define` 注入 `__APP_VERSION__`；`app/src/version.ts` + `app/src/VersionLine.tsx` 在“我 → 设置”（`StudentMe.tsx`）与“我的馆 → 设置”（`TeacherManagement.tsx`）底部显示同一行小字。
- 版本号部署链路（审核意见回改）：`setup.sh` 在宿主机算好短提交号与 `MM-DD`（显式传入的 `APP_VERSION`/`APP_BUILD_DATE` 优先，便于测试/CI），写回 `.env`；`compose.yaml` 把两者作为 web 容器环境变量，`web/entrypoint.sh` 在容器启动时 `npm run build` 能读到；`web/Dockerfile` 加 `ARG/ENV` 默认值。首次部署（quick-start）与更新（update.sh）都会重算并写 `.env` 后再重建 web。镜像里没有 `.git`（.dockerignore 排除），因此不再指望容器内跑 git。
- 验证：app 63 文件 / 496 测试（intake 新增 2 项跳过用例）；typecheck / build / typecheck:e2e 通过；新增 `e2e/v229.browser.mjs` 并加入 CI（跳过不追问且模型调用次数不变、未答项“未提供”、逐问流程继续问再进卡片、两端版本号 = git 短 HEAD、模拟宿主机传 `APP_VERSION=deadbee`/`01-02` 时页面显示“版本 deadbee · 01-02”）；`deployment.test.mjs` 新增 1 项（宿主机短提交号写进 `.env`、compose/Dockerfile/entrypoint 链路、取不到 git 时写 unknown）；带 `APP_VERSION` 的 `vite build` 产物里确认含该字符串；phone / abstractor / opening / storefront 浏览器回归 PASS；真实中继 e2e 本机 28/28。
- 截图：`docs/screenshots/v229-version-student-375.png`、`docs/screenshots/v229-version-teacher-375.png`。
