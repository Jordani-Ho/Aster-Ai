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
- 版本号：`app/vite.config.ts` 构建时用 `git rev-parse --short HEAD` + 当天 `MM-DD` 生成 `短提交号 · 月-日`，Vite `define` 注入 `__APP_VERSION__`；`app/src/version.ts` + `app/src/VersionLine.tsx` 在“我 → 设置”（`StudentMe.tsx`）与“我的馆 → 设置”（`TeacherManagement.tsx`）底部显示同一行小字。
- 验证：app 63 文件 / 496 测试（intake 新增 2 项跳过用例）；typecheck / build / typecheck:e2e 通过；新增 `e2e/v229.browser.mjs` 并加入 CI（跳过不追问且模型调用次数不变、未答项“未提供”、逐问流程继续问再进卡片、两端版本号 = git 短 HEAD）；phone / abstractor / opening / storefront 浏览器回归 PASS；真实中继 e2e 本机 28/28。
- 截图：`docs/screenshots/v229-version-student-375.png`、`docs/screenshots/v229-version-teacher-375.png`。
