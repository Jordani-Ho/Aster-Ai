# domain/tcm · 中医领域内容

V2-04：`kangbi-rules.json` 所有运营数值为 null；`kangbi.ts` 只提供观察值校验与纯计算，生产不启用康币自动写账。任何实际权重、刻数、扣减或上限都须发起人定值，测试专用规则不代表生产配置。

中医专有的内容只放在这里，核心代码里不写中医逻辑。以后做其他师承社区（厨师、设计师等）时，换一个 `domain/` 子目录即可。

| 内容 | 位置 | 状态 |
| :-- | :-- | :-- |
| 八字与年龄换算 | `bazi/` | ✅ 已完成（M1-03） |
| 十问歌与问诊模板 | `templates/` | 老师默认起草模板已实现（M1-10）；学生采集待 M1-09 |
| 子午流注、节气 | `calendar/` | 已实现（M1-13，待审核） |
| 通用节气养生 | `seasonal.json`（类型与查询在 `seasonal.ts`） | M1-18：24 节气起居/饮食/情志要点，只写养生常识不写药方 |
| 三方观察规则 | `observation-rules.json`（类型与算法在 `observation-rules.ts`、`observation.ts`） | V2-10：学生智能体那一句，只观察不写账 |
| 老师智能体材料上限 | `agent-budget.json`（类型与校验在 `agent-budget.ts`） | V2-19：每次模型调用前估算材料长度的上限，默认 16000 tokens（常见 32k 上下文的一半）；换模型只改这个数据 |
| 擅长方向标签表 | `specialties.json` | M2 |
| 体态指标示例与公式 | `posture-metrics.json`（类型与公式引擎在 `posture.ts`） | V2-30：默认四条示例（两肩高低差、骨盆倾斜、头前伸、脊柱偏离中线），老师可改/删/加；不内置正常范围或诊断 |
| 药材单位换算 | `herb-units.json` | V2-24：钱、两折合 0.1 克的整数值由老师确认；初始为空，不写死换算 |

V2-03：tongue-features.json 定义舌象外观取值与配色，tongue.ts 负责严格校验和固定路径的标准 SVG；不输出诊断，也不使用照片像素。

V2-20：`tongue-features.json` 增加 `cropMinShortSide: 160`（裁剪后舌头短边至少 160 像素才算看清；拍照页与解析器都按它判断，不再看“框占画面 5%”）。`tongue.ts` 的框解析同时接受 0–1 与 0–1000 坐标、忽略多余字段；模型回复的 JSON 围栏与前后说明在 `core/abstractor` 里剥离。

V2-10：`observation.ts` 定义三方共用的四选一（改善/持平/变差/说不准，null = 未评价）与观察周期元数据；`observation-rules.ts` + `observation-rules.json` 是学生智能体的那一句的规则（坚持率阈值、舌象方向），不调模型，数据不够一律“说不准”。`kangbi.ts` 的观察记录增加周期与两句话、`effects` 去掉 self；本人感受不在这个目录、也不进康币。

V2-19：`agent-budget.json` 只放一个运营数值 `maxRequestTokens`（默认 16000，按常见 32k 上下文的一半留余量），由 `agent-budget.ts` 校验；估算公式在 `app/src/core/drafting/budget.ts`，不写在这个数据文件里。

