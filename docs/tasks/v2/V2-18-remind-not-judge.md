# V2-18 就医提醒常在，社区不判断急症

- 状态：待派（DeepSeek，接在 V2-17 之后）
- 依据：决策 2026-10-23；医纲第二·一条；白皮书 5.4
- 原则：社区是公共场所，只有提醒的责任。代码不按学生说的话判断急症或心理状况，平台不发心理方面的提醒；判断和责任在老师。

## 范围

1. **删掉关键词判断整套**：`domain/tcm/red-flags.json`、`app/src/core/redflags/`（含测试）、`app/src/RedFlagAlert.tsx`、`app/src/redFlagsData.test.ts`。
2. **问诊流程**：`core/intake/session.ts` 不再调用 `check`、不再有 `emergency` 状态；问诊包和病历里不再写 `redFlag` 字段。老版本发来的包带着这个字段时，照常收，忽略它。
3. **老师端**：收件箱不按急症排先后（`core/inbox/priority.ts` 里相关的去掉；没有别的用途就整个删），面诊页（`VisitPage`、`core/record/in-person.ts`）不再显示或记录急症标记。
4. **常驻提醒**：做成一个组件 `CareReminder`，内容只有一句：“急症请立即去医院或拨打当地急救电话，别等老师回复。”任何地方都不出现心理援助热线。学生问诊三步的顶端都显示，不能关，不拦截发送。V2-17 里已经先放了，这张卡把它抽成组件，文案只在一个地方。
5. **文档**：`core/README.md`、`core/intake/README.md`、`core/record/README.md`、`domain/tcm/README.md` 里有关急症红线的说法一并改掉。

## 验收用例

1. 学生说“胸口闷、冷汗”或心里难受、不想活之类的话，问诊三步和普通情况完全一样：不弹提醒，按钮还是“发给某某老师”；顶端常驻提醒照常显示。
2. 发出的问诊包、老师收到的记录里都没有 `redFlag` 字段；旧包带 `redFlag` 能正常收下。
3. 老师收件箱只按时间排序。
4. `git grep -n "redflags\|redFlag\|red-flags\|RedFlagAlert\|热线\|crisis"` 在 `app/`、`e2e/`、`domain/`、`gateway/` 里搜不到（文档里的决策记录除外）。
5. CI 三项全过；问诊 e2e 断言三步都能看到常驻提醒。
