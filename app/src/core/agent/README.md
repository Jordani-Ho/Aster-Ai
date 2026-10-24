# 智能体骨架（V2-21）

核心只管角色、任务、串行执行与守线，不导入领域内容、提示词、模型或签字工具。现有记忆仍由 records、drafting/materials、mirror 等模块按需提供，不新造一份对话历史。所有任务都是随应用发布的可信代码，不是可执行的模型输出或第三方插件沙箱。

- `role.ts`：`loadAgentRole(store, publicKey, side?)` 从 settings 读取角色。老师模板未配置为 null（领域适配器仍用既有默认模板），邀约默认为 review；学生当前老师取 active-teacher 或老师名单第一位，作息缺失为 null；missing 列出未配置项。invitation-mode 与 agent-routine 是后续基础工作卡的设置口，V2-21 不保存它们或阻断现有开馆。模板与作息此处仅验证 JSON 对象外壳，领域细项由 V2-22/V2-23 校验。
- `tasks.ts`：用 `defineTask` 登记 id、side、trigger、gather、run、confirm、deliver；校验角色、触发类型/钟点/消息类型、确认方式、回调。触发描述是入口元数据，不是后台定时器。time.hour 为本地钟点，时辰由天时工具在触发入口换算。
- `runner.ts`：一次一件事，每次重新 gather；材料必须为有限 JSON，估算不超过调用方提供的额度。默认按 V2-19 的字符估算；领域适配器可按实际拼好的请求计算 tokens，领域上限仍由 domain/tcm/agent-budget.json 提供。能用规则的任务不必提供模型。
- `guard.ts`：产出和发送载荷递归拒绝 source:teacher；不得伪造老师字段。发送必须命中当前本机 teacher-students 或 settings/teachers，且同任务同收件人的发送尝试至少间隔一个时辰（两小时，跨日不重置）。template 任务对外发送还须 allowTemplate 明确允许；缺省拒绝。向外传递用 deliver 的 context.send，不把原始 send 暴露给任务。

## 草稿、确认和幂等

`run(task, {targetId, now?})` 用当前设备本地日期构造 SHA-256 键：side + taskId + targetId + localDay。agent-runs 先保存 draft 与产出；human 只返回草稿给既有核对页，不调用 deliver。后续主动任务可由真人入口调用 confirm；再次触发或确认返回已有产出，不重新 gather/run。confirm 不能凭空生成草稿。template 的本机记录可以直接 deliver，对外消息另检查基础配置。

同页共享串行队列；支持 Web Locks 时跨标签页也串行。没有 Web Locks 的环境只保证同一 JS 运行环境串行，跨标签页应只开一个应用实例。队列完成后不保留材料/结果引用，返回值为副本；持久化的草稿结果用于幂等，按原有保留期清理。写入没有成功时不能宣称已产出/已送达；失败重试允许重新计算未落盘的结果。

发送尝试先写 agent-sent，再调用传递层；断网时可能已经送达，仍保留两小时冷却，避免因不确定结果连发。deliver 可能成功而最终状态写盘失败；再次送出会被冷却拦住，不能承诺“网络副作用严格一次”。后续邀约任务应使用稳定业务事件 id 及传递层幂等，不靠本地状态冒充远端已收。

草稿同时保存原确认方式；同名任务不能把已有 human 草稿改成 template 后自动发出，任务定义有这种变更时拒绝复用旧草稿。

跨日查看人工草稿时，入口把 run 返回的 key 传给 `confirm(task, {targetId, now}, key)`；核对键、任务、角色与对象后，只确认原产出，不重新取材料。发送冷却仍按确认当下的时刻计算，而不是沿用昨天的时钟。是否过时由该业务任务在 deliver 时检查（例如未来邀约的时段是否还有效），骨架不替业务决定。

agent-failures 只留 `{at, kind}` 最近 100 条，没有对象身份、输入、上游原文或模型回复。字段错误、额度、守线、账户、模型不可用、送出、存储分档；重新触发可重试未完成的任务，不在骨架里循环调模型。

## 已接入的两件事

- `drafting/agent.ts` → drafting 任务：对象是问诊卡 encounter.id，不能把“同一学生”当作一天只能问诊一次。远程核对和面诊起草都走这里；沿用 V2-19 的裁材料、额度重试与安全失败提示。只保存模型新增的四诊、判断、方案、材料提示；老师已经录入的 intake/profile 由调用方只读拼回，绝不让模型写 source:teacher。草稿进入原来的 SignReview，签字、钱账入账和退款仍完全在骨架外，不经 runner.confirm。
- `mirror/getDailyMirror` → mirror 任务：对象 self，家人的 LocalStore 分片天然隔离。同日缓存和固定建议回退不变，只在本机落结果，不发送感受或模型上下文。dailyMirror 仍是无存储的生成工具；应用入口使用 getDailyMirror。页面缓存丢失时从已完成任务恢复，不重复生成；测试若要模拟重新生成，需同时清理该镜子任务记录。

## 打开时补做，后台不假装在线

网页在后台或关闭后不能可靠执行任务。“每天”的任务在打开应用/回到前台时，根据本地日期补跑今天未完成的事项；过时提醒不补发。当前镜子页已有打开与跨日入口，病历由老师点起草触发。约定时辰提醒沿用 core/push 的网页推送，只提示“打开看看”；推送不是在后台执行模型的能力。V2-21 不增加推送订阅步骤或假装已实现后续邀约与督促调度。
