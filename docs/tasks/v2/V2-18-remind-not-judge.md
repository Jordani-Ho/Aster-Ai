# V2-18 就医提醒常在，社区不判断急症

- 状态：已完成（2026-10-23，待审核）
- 依据：决策 2026-10-23；医纲第二·一条；白皮书 5.4
- 原则：社区是公共场所，只有提醒的责任。代码不按学生说的话判断急症或心理状况，平台不发心理方面的提醒；判断和责任在老师。

## 范围

1. **删掉关键词判断整套**：`domain/tcm/red-flags.json`、`app/src/core/redflags/`（含测试）、`app/src/RedFlagAlert.tsx`、`app/src/redFlagsData.test.ts`。
2. **问诊流程**：`core/intake/session.ts` 不再调用 `check`、不再有 `emergency` 状态；问诊包和病历里不再写 `redFlag` 字段。老版本发来的包带着这个字段时，照常收，忽略它。
3. **老师端**：收件箱不按急症排先后（`core/inbox/priority.ts` 里相关的去掉；没有别的用途就整个删），面诊页（`VisitPage`、`core/record/in-person.ts`）不再显示或记录急症标记。
4. **常驻提醒**：做成一个组件 `CareReminder`，内容只有一句：“急症请立即去医院或拨打当地急救电话，别等老师回复。”任何地方都不出现心理援助热线。学生问诊三步的顶端都显示，不能关，不拦截发送。V2-17 里已经先放了，这张卡把它抽成组件，文案只在一个地方。
5. **顺手**：删掉 `TeacherStudentsPage` 坚持情况卡片里那句“只显示学生上报的周汇总，不逐日推断。”（V2-17 审核时提过、漏改）；`core/redflags/` 删掉时其 README 一起删。
6. **文档**：`core/README.md`、`core/intake/README.md`、`core/record/README.md`、`domain/tcm/README.md` 里有关急症红线的说法一并改掉。

## 验收用例

1. 学生说“胸口闷、冷汗”或心里难受、不想活之类的话，问诊三步和普通情况完全一样：不弹提醒，按钮还是“发给某某老师”；顶端常驻提醒照常显示。
2. 发出的问诊包、老师收到的记录里都没有 `redFlag` 字段；旧包带 `redFlag` 能正常收下。
3. 老师收件箱只按学生提交的时间排序，没有任何“急症优先”。（发起人：谁都无权判断急症；原则上急症都去医院，不会出现在社区里。）
4. `git grep -n "redflags\|redFlag\|red-flags\|RedFlagAlert\|热线\|crisis"` 在 `app/`、`e2e/`、`domain/`、`gateway/` 里搜不到（文档里的决策记录除外）。
5. CI 三项全过；问诊 e2e 断言三步都能看到常驻提醒。

## 完成记录（2026-10-23）

- 删除：`domain/tcm/red-flags.json`、`app/src/core/redflags/`（含 README 与测试）、`app/src/redFlagsData.test.ts`、`app/src/core/inbox/priority.ts`（含测试）、`scripts/check-red-flags.mjs` 与 CI 的“急症红线只增不减”步骤；`RedFlagAlert.tsx` 在 V2-17 已删，本卡确认无引用。
- 问诊：`core/intake/session.ts` 不再调用 `check`，`IntakeSession` 去掉 `emergency`；`ConsultPackage` / `StoredConsult` / `ConsultEnvelopePayload` 去掉标记字段；`inbox.receiveConsult` 收到旧包里的旧字段时照收、忽略。
- 老师端：`TeacherToday` 用 `sortConsultsBySubmittedAt` 按学生提交时间（`encounter.createdAt`）升序、同时间按病历 id 稳定排序；`VisitPage` 与 `core/record/in-person.ts` 不再显示或记录任何急症标记。
- 常驻提醒：新增 `app/src/CareReminder.tsx`（`CARE_REMINDER` 文案唯一来源），`ConsultPage` 问诊三步顶端渲染；不能关、不拦截发送、不出现热线/电话号码。
- 顺手：删掉 `TeacherStudentsPage` 坚持情况卡片里“只显示学生上报的周汇总，不逐日推断。”；README 同步（app/core/intake/record/inbox/domain、e2e）。
- 验证：`app` 54 文件 / 408 测试；`tsc --noEmit`、`vite build`、`typecheck:e2e` 通过；浏览器脚本 phone/opening/storefront/abstractor/money 全 PASS；本机真实中继 28 条全过。新增/改写用例：`inbox.test.ts` 的收件箱排序 + 旧包字段忽略（旧包带旧字段先到、早提交的后到，仍按提交时间排）；`flow.spec.ts` 两条问诊用例断言三步常驻提醒、无弹窗、无电话号码、发送可用且问诊包不带标记。
- grep 证据：`git grep -n "redflags\|redFlag\|red-flags\|RedFlagAlert\|热线\|crisis" -- app e2e domain gateway` → 无结果；`git grep -n "急症请立即去医院" -- app/src` 只在 `CareReminder.tsx` 一处。
