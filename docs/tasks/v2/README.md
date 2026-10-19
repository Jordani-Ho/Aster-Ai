# 第二版任务卡

依据：`docs/product/v2-structure.md`（结构图）、`docs/product/two-agents.md`、`team/decisions.md`。第一版封存在分支 `archive/v1-frozen`。

## 施工原则（第二版新增）

- **代码越简单越好**。同样的功能，谁写得最少、最直白，就用谁的。
- 第一版里还能用的模块直接复用；用不上的整块删掉，不留开关、不留兼容层。
- 第二版没有真实用户的旧数据，**不做数据迁移**。
- 其余规则照旧见根目录 `AGENTS.md`（一卡一分支一 PR、先写测试、不自审、不合并）。

## 第一批：地基

| 编号 | 任务 | 施工 | 依赖 |
| :-- | :-- | :-- | :-- |
| [V2-01](V2-01-clear-the-ground.md) | 清场：删掉第一版的加密与保护层 | DeepSeek | — |
| [V2-02](V2-02-heaven-time.md) | 天时：当地时辰、天文节气、两种时间显示、照镜子时辰 | DeepSeek | V2-01 |
| [V2-03](V2-03-abstractor.md) | 抽象器：照片 → 抽象图 + 特征，原图即删 | Codex | V2-01 |
| [V2-04](V2-04-two-ledgers.md) | 两本账：钱账（老师一句话记账）与康币账（可调规则 + 观察接口） | Codex | V2-01 |
| [V2-05](V2-05-retention-mutual-backup.md) | 保留期限由老师定；师生互为备份 | DeepSeek | V2-01 |
| [V2-06](V2-06-heaven-on-records.md) | 天地人进问诊包和病历；家人的城市 | DeepSeek | V2-02 |
| [V2-07](V2-07-reidentify.md) | 换手机：靠师生互认找回身份 | DeepSeek | V2-05 |
| [V2-07b](V2-07b-reidentify-family.md) | 换手机：家人随管理人一起认回 | DeepSeek | V2-07 |
| [V2-08](V2-08-tongue-ladder.md) | 舌象抽象一步步来：第一级（舌头裁剪图 + 候选特征，老师说了算） | DeepSeek | V2-03、V2-05 |
| [V2-09](V2-09-storefront.md) | 老师门面第一步：门牌、主题、短介绍、预览 | DeepSeek | V2-05、V2-07 |
| [V2-10](V2-10-three-way-observation.md) | 观察：老师和智能体各说一句“这段时间怎么样” | DeepSeek | V2-04、V2-05 |

| [V2-11](V2-11-selftest-ready.md) | 内测准备：家里部署对齐第二版 + 一页“内测怎么开始” | DeepSeek | V2-01 至 V2-10 |

第二批（地基合并后再展开）：自我调整（表层配置化）、门面、物流（本地资源）、观察。
