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
| [V2-12](V2-12-first-ledger.md) | 钱账第一次就能记：老师端首次建账和币种入口 | DeepSeek | V2-04、V2-11 |
| [V2-13](V2-13-teacher-on-phone.md) | 老师端全在手机上用 | DeepSeek | V2-12 |
| [V2-14](V2-14-community-dashboard.md) | 社区仪表盘：每个馆只交统计数，我们只看不改 | DeepSeek | V2-13 |
| [V2-15](V2-15-open-the-hall.md) | 建馆：老师第一次进来，一步一步开馆（排在 V2-13 之前） | DeepSeek | V2-12 |
| [V2-16](V2-16-new-ui-first.md) | 新界面第一批：老师今天、面诊、核对签字、学生首页 | DeepSeek | 设计稿 docs/design/ |
| [V2-17](V2-17-new-ui-second.md) | 新界面第二批：建馆、学生、我的馆，进馆、问诊、记录、我 | DeepSeek | V2-16 |
| [V2-18](V2-18-remind-not-judge.md) | 就医提醒常在，社区不判断急症 | DeepSeek | V2-17 |
| [V2-19](V2-19-one-task-one-page.md) | 老师智能体：一事一议，只向签字学习，额度有上限 | DeepSeek | V2-18 |
| [V2-20](V2-20-tongue-fix.md) | 舌象修复：镜子显示完整，拍摄少失败、失败说得清 | DeepSeek | — |
| [V2-21](V2-21-agent-core.md) | 智能体骨架：角色、记忆、主动、守线 | Codex | V2-19 |
| [V2-22](V2-22-hall-groundwork.md) | 开馆基础工作：老师智能体进入角色 | Codex | V2-21 |
| [V2-23](V2-23-student-groundwork.md) | 进馆基础信息：学生智能体进入角色 | Codex | V2-21 |
| [V2-24](V2-24-herbs.md) | 药材库：老师和学生同一套 | Codex | V2-22 |
| [V2-25](V2-25-appointments.md) | 预约：老师智能体主动请人来 | Codex | V2-22 |
| [V2-26](V2-26-voice-two-organize.md) | 问诊录音与两次整理 | Codex | V2-21 |
| [V2-27](V2-27-student-nudge.md) | 学生智能体的督促 | Codex | V2-21、V2-25 |
| [V2-28](V2-28-open-hall-foolproof.md) | 建馆傻瓜化与实测小问题 | DeepSeek | — |

第二批（地基合并后再展开）：自我调整（表层配置化）、门面、物流（本地资源）、观察。
