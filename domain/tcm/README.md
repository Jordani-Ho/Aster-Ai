# domain/tcm · 中医领域内容

V2-04：`kangbi-rules.json` 所有运营数值为 null；`kangbi.ts` 只提供观察值校验与纯计算，生产不启用康币自动写账。任何实际权重、刻数、扣减或上限都须发起人定值，测试专用规则不代表生产配置。

中医专有的内容只放在这里，核心代码里不写中医逻辑。以后做其他师承社区（厨师、设计师等）时，换一个 `domain/` 子目录即可。

| 内容 | 位置 | 状态 |
| :-- | :-- | :-- |
| 急症红线清单与引擎 | `red-flags.json`（引擎在 `app/src/core/redflags/`） | ✅ v2（M1-04）；C 类：增删改须经发起人确认 |
| 八字与年龄换算 | `bazi/` | ✅ 已完成（M1-03） |
| 十问歌与问诊模板 | `templates/` | 老师默认起草模板已实现（M1-10）；学生采集待 M1-09 |
| 子午流注、节气 | `calendar/` | 已实现（M1-13，待审核） |
| 通用节气养生 | `seasonal.json`（类型与查询在 `seasonal.ts`） | M1-18：24 节气起居/饮食/情志要点，只写养生常识不写药方 |
| 三方观察规则 | `observation-rules.json`（类型与算法在 `observation-rules.ts`、`observation.ts`） | V2-10：学生智能体那一句，只观察不写账 |
| 擅长方向标签表 | `specialties.json` | M2 |

V2-03：tongue-features.json 定义舌象外观取值与配色，tongue.ts 负责严格校验和固定路径的标准 SVG；不输出诊断，也不使用照片像素。

V2-10：`observation.ts` 定义三方共用的四选一（改善/持平/变差/说不准，null = 未评价）与观察周期元数据；`observation-rules.ts` + `observation-rules.json` 是学生智能体的那一句的规则（坚持率阈值、舌象方向），不调模型，数据不够一律“说不准”。`kangbi.ts` 的观察记录增加周期与两句话、`effects` 去掉 self；本人感受不在这个目录、也不进康币。

