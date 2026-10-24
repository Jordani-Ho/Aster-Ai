# 知衡（旧版 zhiheng-tcm）功能与「防错」盘点报告

> 盘点对象：`D:\projects\zhiheng-tcm`，HEAD `9585752`（2026-10-12，与你方审计报告同一提交）
> 盘点日期：2026-10-23
> 盘点性质：**只读静态盘点**。未启动服务、未连接数据库、未运行测试、未修改仓库任何文件、未提交。
> 证据口径：`文件:行号` 均来自本次亲手阅读；凡引用仓库自带文档的结论，单独标注「文档证据」并给出文档行号。

---

## 0. 一句话结论

**旧版把「模板工作室」做成了一个接近可交付的模块（契约、两档校验、状态机、幂等、DB 约束都在），而「排班 / 预约 / 库存 / 档案」四块是第 47–55 天按天追加的功能——没有设计文档、没有契约、没有测试、没有事务、没有审计，防错主要靠前端提示和「老师自己小心」。**

更具体地说：

1. **排班保存接口目前是坏的**（重复路由 + 装饰器套在类上），前端却提示"已保存"——`main.py:942-970`、`App.tsx:1012-1022`。
2. **预约只查「该时段有没有人」，不查「这是不是老师的上班时间 / 是不是节假日 / 是不是过去」**，冲突检查与写入还不在同一事务、表上也没有唯一索引——`database.py:1431-1473`。
3. **开方扣库存是「先扣、再写药方」，两个连接、两个事务、无补偿**；同一张方子写两味同名药还会少扣；数量传负数会**加**库存——`database.py:1755-1777`、`1877-1901`。
4. **学生档案是 8 表物理硬删**，无身份、无审计、无墓碑，与自家设计文档「删除 = tombstone」正相反——`database.py:588-594`。
5. **全站没有身份层**：所有接口以「请求方自报的姓名」为准，`teacher_name == teacher_id` 只校验了两个参数是否相等，不校验"你是谁"——这是所有越权问题的根，项目自己在 `decision-log.md:479-488`（D-020）已承认。

---

## 1. 盘点方法与边界

### 1.1 读了什么

| 层次 | 对象 |
| :-- | :-- |
| 项目说明 | `README.md`（33 行） |
| 设计/审计文档 | `docs/audit-2026-10-15.md`、`docs/development-plan-v1.md`、`docs/tech-debt.md`、`docs/whitepaper-v2.1.md`、`docs/epic1-template-design-v1.md`、`docs/phase2-data-sovereignty-design.md`、`docs/migrations/*` |
| 团队台账 | `team/decisions/decision-log.md`（D-020 无鉴权）、`team/decisions/ruling-2026-10-04-数据主权与归档封存.md`、`team/worklogs/*` |
| 后端 | `backend/database.py`(3,289 行)、`main.py`(1,370)、`template_api.py`(360)、`template_service.py`(1,035)、`teacher_service.py`(177)、`export_api.py`(91)、`agent.py`（按需）、`alembic/versions/0001` |
| 前端 | `frontend/src/App.tsx`(4,816)、`TemplateStudio.tsx`(1,476)、`TeacherOnboarding.tsx`(161)、`appShared.ts`(232)、`identityBootstrap.ts` |

### 1.2 没做什么（避免误读）

- 没有启动 FastAPI / Vite，没有连 `zhiheng.db` / `test.db`（只读 `.py` 源码与 `.md` 文档）。
- 没有跑 pytest / vitest。凡"实测"字样，均指**仓库自带审计报告中的实测记录**，已单独标注。
- 没有修改仓库任何文件（`git status` 保持原样；报告写到仓库之外的 `D:\tmp`）。

### 1.3 风险分级口径

| 级别 | 含义 | 典型后果 |
| :-- | :-- | :-- |
| **高** | 会直接造成数据错误、库存/款项损失、越权访问，或功能"静默失败" | 扣错库存、丢病历、任何人不登录即可改别人数据 |
| **中** | 可被绕过、会产生歧义数据，或有明确恢复路径 | 状态可倒退、审计缺失、脏数据可写入 |
| **低** | 体验/维护性问题，短期不致命 | 提示不清、常量漂移、无回收站 |

---

## 2. 七个模块总览

| # | 模块 | 主要代码 | 数据表 | 现状判定 | 最高风险 |
| :- | :-- | :-- | :-- | :-- | :-- |
| 1 | 老师工作时间 / 排班 / 节假日 | `main.py:919-970`、`database.py:1297-1397`、`App.tsx:1001-1051` | `teacher_settings` | **能用一半**：读得出、画得出、存不进（接口坏） | 高（保存静默失败 + 零校验） |
| 2 | 预约 | `main.py:972-1060`、`database.py:1399-1482`、`App.tsx:2283-2336`、`3692-3868` | `appointments` | **能跑通主流程**：约、确认、取消；规则全是占位 | 高（不校验排班/节假日/过去 + 无状态机 + IDOR） |
| 3 | 药材库存（含开方扣库存） | `main.py:1070-1181`、`database.py:1664-1944`、`App.tsx:1054-1215`、`3896-3997`、`4613-4660` | `herb_inventory`、`prescriptions` | **能演示**：入库存、九宫格开方、当面扣/远程不扣 | 高（扣减与落库不在一个事务 + 数量可负数 + 无流水） |
| 4 | 学生档案 | `main.py:268-331`、`database.py:561-622`、`App.tsx:2181-2220`、`3501-3575`、`3896-3910` | `patients`、`patient_profiles`、`patient_records`、`patient_teachers` | **能建档能看**：含八字/五行现算 | 高（8 表硬删 + 无鉴权读 + 出生信息可改无版本） |
| 5 | 老师引导（onboarding） | `teacher_service.py` 全文、`TeacherOnboarding.tsx`、`App.tsx:3591-3602` | `teachers` + `lineage` | **只有一个"入社区"动作**，无引导流程 | 高（无鉴权 + 同名即同人） |
| 6 | 模板工作室 | `template_api.py`、`template_service.py`、`TemplateStudio.tsx`、`0001_create_templates.py` | `templates`、`plan_templates` | **最完整**：9 端点、两档校验、状态机、版本链 | 中（身份自报、未保存提示缺失、AI 后置校验缺失） |
| 7 | 防错总览 | 见第 10 节矩阵 | — | — | — |

> **文档对照**：`docs/development-plan-v1.md:42-54` 的「已完成」清单里**没有**排班、预约、库存这三项；`docs/whitepaper-v2.1.md:406-407` 把"时间管理 / 库存管理"划给**智能体**，而 `backend/agent.py` 全文 grep 不到 `库存 / 预约 / 排班 / inventory / appointment`（0 命中）。也就是说：这三块既不在人的交付清单里，也没被智能体接走，处于「谁都没认领」的状态。

---

## 3. 横切根问题（七项共用，先看这一节）

这六条不是某一个模块的缺陷，而是**所有**模块的放大器；后面各章的"缺失防错"多半是它们的表现形式。

### 3.1 X-01 没有身份层（高）

`main.py` 全文没有任何鉴权依赖（无 `Depends` 取 token/session），CORS 为 `allow_origins=["*"]`（`main.py:28-34`）。身份靠请求参数自报：`teacher_name` / `patient_name` 直接来自 query 或 body。

仓库里的"鉴权"只有一处真实实现，且只用于治理见证人：`witness_auth.py:15-31` 的硬编码 token（`witness-dev-initiator` / `witness-dev-zhieng`）。其余模块用 `teacher_name == teacher_id` 充当身份校验（`template_api.py:82-87`、`teacher_service.py:96-103`、`export_api.py:48-55`）——它防的是"参数写错"，不是"冒充"。

项目自己已下过结论：`team/decisions/decision-log.md:485`——「后端**无 token / 无 session**，`teacher_name` / `student_name` 全由请求方**自报**；`lineage_read_scope` 只校『参数间一致性』，**不校『你是谁』**」。

**影响面**：排班可被任意改；预约可被任意确认/取消；库存可被任意增减/删除；档案可被任意读/导出/删除；模板可被任意读写。

### 3.2 X-02 业务失败走 HTTP 200（高）

旧版大量"失败"以 `{"error": ...}` / `{"message": "扣减失败…"}` + **HTTP 200** 返回，且不是所有前端都检查 body：

- 预约冲突：`database.py:1463-1464` 返回 `{"error": ...}`，`main.py:985-991` 原样 200 返回。
- 开方库存不足：`database.py:1889-1890` 返回 `{"error": ...}`，`main.py:1166-1175` 原样 200 返回。
- 批量扣减失败：`main.py:1107-1112` 返回 200 + `message:"扣减失败，库存不足"`。
- 签字失败：`main.py:845-846, 860-861` 返回 `{"error": ...}` 200。

对比模板接口：错误一律真实 HTTP 状态码 + `{detail:{error,msg,errors,warnings}}`（`template_api.py:39-59`）。**同一个仓库里存在两套错误契约**，这正是"前端忽略失败"的温床（见 APT-05、SCH-01）。

### 3.3 X-03 没有操作审计（高）

排班、预约、库存、档案四张表**都没有 `updated_by` / 操作日志**：`teacher_settings` 连 `updated_at` 都没有（`database.py:237-245`），`appointments` 只有 `created_at`/`confirmed_at`（`256-270`），`herb_inventory` 只有 `updated_at`（`1670`）。

仓库里确有审计能力，但只覆盖治理侧：`agent_action_log`（`390`）、`agent_stage_log`（只增）、`seal_events`、`agent_learning_events`、witness 哈希链。**业务侧零审计**——"库存为什么少了 300 克""这单是谁取消的"都答不上来。

### 3.4 X-04 没有事务边界，SQLite 用默认配置（高）

`get_connection()` 就是 `sqlite3.connect(DB_PATH)`（`database.py:10-13`），全库没有 `PRAGMA journal_mode` / `busy_timeout` / `isolation_level` 这类连接级设置（grep `PRAGMA` 只命中 `table_info` 的列探测）。每个函数自己开、自己提交、自己关，**跨函数的业务动作没有共同事务**。

于是：预约"查占用 + 插入"是两次写（TOCTOU）；库存"扣减 + 落方"是两个连接（见 INV-01）。并发下既可能丢更新，也可能触发 `database is locked`。

### 3.5 X-05 时间只有"本地朴素时间"（中）

全库时间戳写 `datetime.now().isoformat()`（无 tzinfo），唯一带 UTC 的是导出接口的 `datetime.utcnow().isoformat()+"Z"`（`export_api.py:78`）。没有时区配置、没有统一时间服务；`parse_interaction_at` 甚至要把带时区的值 `replace(tzinfo=None)` 后再和本地 `now` 相减（`database.py:1201-1215`）。

后果：跨时区/夏令时的"今天""未来 7 天""是否过期"都可能差一天；导出时间与业务时间不在同一时间轴。

### 3.6 X-06 双轨 schema（中）

`database.init_db()` 用 `CREATE TABLE IF NOT EXISTS` + `try: ALTER TABLE`（7 处：`220/248/273/319/323/341/432`），同时又有 alembic `0001–0009`，且迁移失败**不阻塞启动**（`main.py:45-53`）。真实的库结构取决于"哪个先跑、跑没跑成功"。

新增表（templates / agent_stage / learning / seal / referral）走 alembic；业务表（teachers / patients / appointments / herbs）走 init_db。**同一份代码里两套 DDL 机制**，v2 必须二选一。

---

## 4. 模块一：老师工作时间 / 排班 / 节假日

### 4.1 功能现状

**数据表**：`teacher_settings(teacher_name TEXT PRIMARY KEY, work_days TEXT, work_hours TEXT, work_schedule TEXT, holidays TEXT)`（`database.py:237-253`）。全是 TEXT，无约束、无审计字段；`work_schedule` 与 `holidays` 存 JSON 字符串。

**接口**（全部无鉴权、无归属校验）：

| 方法 | 路径 | 实现 | 作用 |
| :-- | :-- | :-- | :-- |
| GET | `/api/teacher-settings` | `main.py:925-927` → `database.py:1378-1387` | 粗粒度：周几 + 整点列表 |
| POST | `/api/teacher-settings` | `main.py:929-931` → `database.py:1389-1397` | 写 `work_days` / `work_hours` 字符串 |
| GET | `/api/teacher-schedule` | `main.py:964-966` → `database.py:1339-1365` | 按周几 × 半小时时段 |
| POST | `/api/teacher-schedule` | `main.py:968-970` → `database.py:1367-1375` | 写 `work_schedule` JSON |
| GET | `/api/teacher-holidays` | `main.py:948-950` → `database.py:1297-1307` | 读节假日数组 |
| POST | `/api/teacher-holidays` | `main.py:952-954` → `database.py:1309-1318` | **全量覆盖**节假日数组 |
| GET | `/api/appointments/calendar` | `main.py:1004-1052` | 未来 7 天 × 时段 + 已约 + 是否节假日 |

**前端**：设置页「⚙️ 设置 → 分区② 作息与节假日」（`App.tsx:3615-3617` 起），含"我的工作时间"（按天切换 + 上午/下午/晚间时段按钮，`3624-3667`）、"节假日设置"列表（`3669-3688`）、7 天日历（`3729-3793`）。

**时段常量**：`ALL_SLOTS` 26 个半小时（08:00–20:00，`database.py:1321-1325`）；默认排班 = 周一到周五 09:00–11:30 + 14:00–16:30（`1327-1337`）；前端另有一份分组常量 `morningSlots/afternoonSlots/eveningSlots`（`App.tsx:2363-2365`）。

### 4.2 关键流程（按代码实际）

```
老师打开设置页
  → fetchSchedule(): GET /api/teacher-schedule
      → 无行 → _default_schedule()（周一到周五 09:00-11:30 / 14:00-16:30）
      → 有行且 work_schedule 可解析 → 补全 0-6 七个键后返回
      → 有行但解析失败 → 回落 work_days/work_hours 旧字段（1339-1365）
  → setSchedule + setTempSchedule(深拷贝)   // 编辑态用副本
  → 点格子 toggleSlot() 改 tempSchedule（纯本地，1348-1354）
  → 点保存 POST /api/teacher-schedule {teacher_name, schedule}
      → 后端 json.dumps 直接写库（1367-1375）
      → 前端不检查 res.ok，直接 setSchedule、关编辑态、alert("工作时间已保存")

学生/老师看日历
  → GET /api/appointments/calendar（main.py:1004）
      → 取该老师 schedule + holidays
      → 未来 7 天逐日：schedule[js_day]；若 date in holidays → slots=[]
      → 聚合 booked（status != cancelled）
  → 前端点空闲格 → 预填 apptDate/apptTime → 打开预约表单

节假日
  → 添加：前端校验非空 + 去重 + 排序 → POST 全量数组
  → 删除：confirm 后 POST 全量数组
```

### 4.3 已有的防错

| 已有防错 | 位置 | 说明 |
| :-- | :-- | :-- |
| 编辑态用副本，可取消 | `App.tsx:1007`、`1348-1354` | 不点保存不落库 |
| 删除节假日二次确认 | `App.tsx:1043-1044` | 仅前端 |
| 节假日去重 + 排序 | `App.tsx:1034-1035` | 仅前端 |
| 日历区分「节假日 / 无排班 / 有空」 | `App.tsx:3754-3759` | 文案明确 |
| 已占用时段置灰不可点 | `App.tsx:3774-3790` | 前端层面防重复预约 |
| 缺键补齐 + 解析失败回落 | `database.py:1347-1365` | 旧数据兼容 |
| 默认排班兜底 | `database.py:1344-1345` | 新老师不会"一周全空" |

### 4.4 缺失的防错

| 编号 | 缺失项 | 风险 | 证据 | 后果 |
| :-- | :-- | :-- | :-- | :-- |
| **SCH-01** | **保存排班接口不可用**：`POST /api/teacher-schedule` 声明了两遍，第一遍的 `@app.post` 装饰器紧跟着 `class HolidaysInput`，把类注册成了端点；FastAPI 按注册顺序匹配，错误那条先命中 | **高** | `main.py:942-959`（装饰器 → 类）、`main.py:968-970`（真正的函数）；仓库审计已用 TestClient 复现 422：`docs/audit-2026-10-15.md:93-107`（文档证据，本次未运行） | 老师在界面改排班**静默失败**；前端 `handleSaveSchedule` 不看 `res.ok`（`App.tsx:1012-1022`）还提示"已保存" |
| **SCH-02** | 排班/工作时间入参零校验：`work_days`/`work_hours` 任意字符串；`schedule` 任意 dict（可为 list、None、超大对象、非白名单时段） | **高** | `main.py:920-931`（`work_days: str`）、`934-937`（`schedule: dict`）、`database.py:1367-1375`（直接 dumps） | 脏数据进库 → `get_teacher_schedule` 解析异常被吞 → 静默回落到旧的 `work_days`，表现为"我明明设了周三，周三却全空" |
| **SCH-03** | 排班/节假日变更**不回看已存在预约**：无冲突扫描、不拦截、不通知、不提供改约 | **高** | 冲突只在创建时查一次：`database.py:1431-1447`、`1462-1473`；`update_appointment_status` 无任何校验（`1475-1482`） | 老师把周三设休息，周三已确认的 3 个号无声保留；病人来了没人 |
| SCH-04 | 节假日零校验：任意 JSON 数组、任意字符串、可重复、可传过去日期、可传 `2026/10/01` | 中 | `main.py:944-954`（`holidays: list`）、`database.py:1309-1318`（直接 `json.dumps`） | 日历用 `date_str not in holidays` 做**字符串精确匹配**（`main.py:1032`），格式不一致即静默失效 |
| SCH-05 | 时段白名单**三处漂移**：后端 26 格、默认排班 09:00–16:30、前端三组常量 08:00–20:00 | 中 | `database.py:1321-1325`、`1327-1337`、`App.tsx:2363-2365` | 改一处必漂；新格子在后端不认 |
| SCH-06 | 无操作者、无修改时间、无审计 | 中 | `database.py:237-245`（表无 `updated_at`） | 谁把周三关了查不到 |
| SCH-07 | "今天"取服务器本地时间，无时区 | 低 | `main.py:1008`、`1025`；`database.py:1248` | 跨时区/夏令时"未来 7 天"偏一天 |
| SCH-08 | 无"单次时长/诊位容量"概念 | 低 | 一个 30 分钟格 = 一个号（`ALL_SLOTS`，`database.py:1321`） | 无法设 60 分钟面诊或并行诊位 |

### 4.5 对 Aster-Ai v2 的可复用点与建议

**能搬：**

- **「周模板 + 日期例外」两层模型**（`schedule[weekday] = [slots]` + `holidays`）——简单、够用、UI 好画。
- **7 天 × 时段投影接口**（`days[].slots / booked / is_holiday`，`main.py:1044-1050`）——可直接作为 v2 的排班读模型契约。
- **编辑态副本 + 取消丢弃**的交互（`App.tsx:1007/1348`）。

**要改造：**

1. 时段用**枚举/区间表**（`slot` 表或 `time` 类型数组），去掉"字符串白名单散落三处"，前端从后端拉选项。
2. 保存前做 **diff**：若"取消的时段"上已有 `confirmed` 预约 → 返回 409 + 受影响列表，让老师选「保留该日号源 / 批量改约 / 取消并通知」。这是 v2 最该补的一条排班防错。
3. 节假日用**日期类型 + 唯一约束**，支持半天、单次例外、临时加诊。
4. 加 `updated_by / updated_at`，并把变更写入统一审计表。

**不能搬：**

- `work_days/work_hours` 与 `work_schedule` **双写两套**（历史遗留，`database.py:1356-1364` 还在回落）——v2 只保留一套结构化排班。
- 把 JSON 字符串塞进 TEXT 列（无法索引、无法约束、无法查询某天有谁上班）。
- 用类当路由端点的写法（就是 SCH-01 的成因）。

### 4.6 证据

- `backend/database.py:237-253`：`teacher_settings` DDL（含 `holidays` 补列），无约束无审计列。
- `backend/database.py:1297-1318`：节假日读/全量覆盖写，无校验。
- `backend/database.py:1321-1337`：`ALL_SLOTS` 与默认排班。
- `backend/database.py:1339-1365`：读排班，含"解析失败静默回落"。
- `backend/database.py:1367-1375`：写排班，直接 `json.dumps`。
- `backend/database.py:1378-1397`：粗粒度工作时间读写。
- `backend/main.py:919-931`：`TeacherSettingsInput`（两个 `str`，零校验）。
- `backend/main.py:934-970`：重复路由 + 装饰器套类（SCH-01 现场）。
- `backend/main.py:1004-1052`：7 天日历；`1032` 假日字符串精确匹配。
- `frontend/src/App.tsx:1001-1022`：读排班；`1012-1022` 保存不判 `res.ok`。
- `frontend/src/App.tsx:1024-1051`：节假日增删（前端去重/排序/确认）。
- `frontend/src/App.tsx:2363-2365`、`3692-3723`、`3754-3790`：时段常量、分区标题、日历渲染。
- `docs/audit-2026-10-15.md:93-107`：同一缺陷的 TestClient 复现记录（文档证据）。

---

## 5. 模块二：预约

### 5.1 功能现状

**数据表**：`appointments(id, patient_name, teacher_name, initiator, scheduled_date, scheduled_time, reason, status, created_at, confirmed_at, is_remote)`（`database.py:256-275`）。

关键事实：**没有唯一约束、没有索引、没有 CHECK**；`status` 是自由 TEXT（默认 `pending`）；`scheduled_date` / `scheduled_time` 都是 TEXT。全库唯一一条用 `CREATE UNIQUE INDEX` 建的业务约束是模板的 `uq_templates_active_one`（`0001_create_templates.py:58-59`）；其余唯一性都是建表时的列级 `UNIQUE`（如 `herb_inventory`）——**预约表连列级唯一都没有**。

**接口**：

| 方法 | 路径 | 实现 | 缺什么 |
| :-- | :-- | :-- | :-- |
| POST | `/api/appointments` | `main.py:985-991` → `database.py:1450-1473` | 不校验排班/节假日/过去/格式；失败 200 |
| GET | `/api/appointments` | `main.py:993-1002` → `database.py:1400-1428` | 5 个可选过滤，无分页 |
| GET | `/api/appointments/calendar` | `main.py:1004-1052` | 只覆盖未来 7 天 |
| POST | `/api/appointments/{id}/confirm` | `main.py:1054-1056` → `1475-1482` | 无状态机、无存在性、无身份 |
| POST | `/api/appointments/{id}/cancel` | `main.py:1058-1060` → `1475-1482` | 同上；取消也写 `confirmed_at` |

**前端**：预约卡片在设置页（学生端始终显示，老师端归入「分区③」`App.tsx:3692-3867`）；诊室「🩺 诊室队列」双列（`4163-4325`）。

### 5.2 关键流程（按代码实际）

```
学生：日历点空格 → apptDate/apptTime 预填 → 填原因 → 选当面/远程 → 提交
  → POST /api/appointments
      → check_slot_available(teacher, date, time)   // 只查"同一时刻是否已有人"
      → 冲突：return {"error": "该时段已被预约…"}（HTTP 200）
      → 否则 INSERT status=pending, created_at=now, is_remote 0/1
  → 前端 .then(() => { 关表单; 清字段; fetchAppointments() })   // 不看 error

老师：GET /api/appointments?teacher_name=… → 待处理列表（status=pending）
  → 确认：POST /{id}/confirm → UPDATE status=confirmed, confirmed_at=now
  → 取消：POST /{id}/cancel  → UPDATE status=cancelled, confirmed_at=now

诊室队列：appointments.filter(status=confirmed && date>=today)
  → 左列 = reason 未命中远程关键词；右列 = 命中
```

### 5.3 已有的防错

| 已有防错 | 位置 | 说明 |
| :-- | :-- | :-- |
| 时段占用检查 | `database.py:1431-1447` | 排除 `cancelled`，并预留了 `exclude_appt_id` |
| 前端只渲染空闲格、占用置灰 | `App.tsx:3762-3790` | 正常路径下造不出重复号 |
| 取消二次确认 | `App.tsx:2333-2335` | 仅前端 |
| 表单必填校验 | `App.tsx:2304-2307` | 日期/时间/原因 |
| `is_remote` 0/1 显式落库 | `main.py:973-983`、`database.py:1467-1469` | D-053 修复 |
| 时间戳改真实时间 | `database.py:1469`、`1479` | 原先硬编码 `2026-09-21` |

### 5.4 缺失的防错

| 编号 | 缺失项 | 风险 | 证据 | 后果 |
| :-- | :-- | :-- | :-- | :-- |
| **APT-01** | 创建预约**只查时段占用**，不查「是否在老师排班内 / 是否节假日 / 是否过去 / 日期时间格式」 | **高** | `database.py:1462-1473`：唯一的前置条件是 `check_slot_available`；`check_slot_available` 只比三个字段（`1431-1447`） | 可写出「周日 03:00」「节假日」「昨天」的号；导入/脚本/直连 API 都能造 |
| **APT-02** | 冲突检查与插入**不在同一事务**，表上无唯一索引 → TOCTOU | **高** | 先 `SELECT COUNT`（1431-1447）、后 `INSERT`（1465-1471），两个独立连接；无 `UNIQUE(teacher_name, scheduled_date, scheduled_time)`（全库 grep 无） | 并发/双击/重试可产生两条同时段预约；前端置灰只挡正常路径 |
| **APT-03** | **无状态机**：任意 → 任意；`cancelled` 可被 `confirm` 复活；对不存在的 id 也返回"已更新" | **高** | `database.py:1475-1482`（一条 UPDATE + 固定成功文案）；`main.py:1054-1060` | 状态可倒退、可重复确认；"取消成功"可能是假的 |
| **APT-04** | **越权（IDOR）**：confirm/cancel 只认 id，无身份、无归属校验 | **高** | `main.py:1054-1060` | 任何人可取消/确认任何人的预约（含跨老师、跨师门） |
| **APT-05** | 前端**忽略失败体**：提交后直接关表单清字段刷新，不看 `{"error"}` | **高** | `App.tsx:2322-2326` | 时段冲突表现为"提交成功但列表里没有"，用户反复提交 |
| APT-06 | 失败语义 200 + `{"error"}`，与 400/409 混用 | 中 | `main.py:985-991`、`database.py:1463-1464` | 客户端无法用状态码判断；监控无法告警 |
| APT-07 | 无改期、无取消原因/取消人、无审计、无通知 | 中 | 全库 grep `改期/reschedule/取消` 在 backend 中命中 **0**；`appointments` 无 `cancelled_by/cancel_reason` 列 | 改约只能"取消 + 新建"，历史断链；谁取消无记录 |
| APT-08 | 预约规则全是**只读占位**：提前 7 天、30 分钟、提前 2 小时可取消、余额门限 | 中 | `App.tsx:3697-3707`（"只读占位，未接后端"）、`3877-3878` | 规则写在界面上但不生效，形成"承诺了却没做"的风险 |
| APT-09 | 远程/面诊**双源判定**：`is_remote` 已落库，但诊室队列仍按 `reason` 关键词分列 | 中 | `App.tsx:2402`（`REMOTE_APPT_KEYWORDS`）、`appShared.ts:93`（远程/线上/网诊/视频/电话/微信） | 原因写"电话沟通后当面复诊"即被错分到远程列 |
| APT-10 | 今天**已过去的时段**仍出现在日历并可点 | 中 | `main.py:1024-1050` 从 `today` 起整日生成，不过滤当前时刻 | 下午 5 点还能约当天 9 点 |
| APT-11 | 学生端**没有取消入口**，但接口允许（且无鉴权） | 中 | `App.tsx:3817-3829` 只渲染状态；对照组 `3807-3808` 老师端才有按钮 | 规则承诺"2 小时前可自行取消"无处执行 |
| APT-12 | 日期/时间为 TEXT，排序靠字符串拼接；无时区归一 | 低 | `App.tsx:2397`（`a.scheduled_date + a.scheduled_time`）、`database.py:1426` | 格式不统一即错序 |
| APT-13 | `initiator` 只是自由字符串，无枚举校验 | 低 | `main.py:976`、`database.py:1467` | 可写任意值，统计不可信 |

### 5.5 对 Aster-Ai v2 的可复用点与建议

**能搬：**

- **「时段即号源」模型**：一个 30 分钟格 = 一个可约单位，日历接口一次返回 `slots/booked/is_holiday`，前端零计算。
- **三态简化**（pending / confirmed / cancelled）+ `is_remote` 布尔。
- **诊室队列 = 今天及以后 + confirmed + 时间升序**的派生逻辑（`App.tsx:2395-2397`），可直接做成服务端视图。

**要改造（按优先级）：**

1. **号源可用性服务**：`available = 排班 ∩ ¬节假日 ∩ ¬过去 ∩ ¬已占用`，创建与改期都调它，一个实现（现在散在后端 `check_slot_available` 与前端日历两处）。
2. **DB 兜底**：`UNIQUE(teacher_id, slot_start) WHERE status <> 'cancelled'`（SQLite 部分索引 / PG 部分唯一索引），把并发挡在数据库层。
3. **显式状态机**：`pending→confirmed→(cancelled|completed|no_show)`，非法转移 409；`cancel` 记录 `cancelled_by / reason / at`。
4. **幂等**：创建带 `client_request_id`，重复提交返回同一条。
5. **规则落地**：把 `App.tsx:3697-3707` 的四条规则做成 `appointment_policy`（可配置：提前 N 天、时长、取消窗口、余额门限），由服务端执行并在 UI 显示"为什么不能约"。

**不能搬：**

- `reason` 关键词判远程（APT-09）——v2 一律用 `is_remote` / `mode` 枚举。
- HTTP 200 + `{"error"}`（APT-06）。
- 只认 id 的操作端点（APT-04）——v2 必须 `资源.owner == token.subject`。
- "规则只读占位"卡片——宁可不显示，也不要让用户以为规则生效了。

### 5.6 证据

- `backend/database.py:256-275`：`appointments` DDL（无约束、无索引、`is_remote` 补列）。
- `backend/database.py:1400-1428`：列表查询（可选过滤、无分页）。
- `backend/database.py:1431-1447`：`check_slot_available`（仅三字段比对，排除 cancelled）。
- `backend/database.py:1450-1473`：创建（先查后插，返回 `{"error"}`）。
- `backend/database.py:1475-1482`：状态更新（无状态机、无存在性校验、取消也写 `confirmed_at`）。
- `backend/main.py:973-1060`：入参模型与五个端点（confirm/cancel 无身份）。
- `backend/main.py:1004-1052`：7 天日历（含 `date_str not in holidays`）。
- `frontend/src/App.tsx:2303-2327`：提交预约不判失败。
- `frontend/src/App.tsx:2329-2336`：确认/取消（取消有 confirm）。
- `frontend/src/App.tsx:2393-2404`：诊室队列按原因关键词分列。
- `frontend/src/App.tsx:3692-3707`：预约规则四条"只读占位"。
- `frontend/src/App.tsx:3762-3790`、`3817-3829`：日历网格、学生端只读列表。

---

## 6. 模块三：药材库存（含开方扣库存）

### 6.1 功能现状

**数据表**：

| 表 | 字段 | 约束 |
| :-- | :-- | :-- |
| `herb_inventory` | `id, teacher_name, herb_name, stock_amount REAL, unit, warn_threshold REAL, updated_at` | `UNIQUE(teacher_name, herb_name)`（`database.py:1670`） |
| `prescriptions` | `id, teacher_name, patient_name, items_json, note, created_at, is_remote` | 无约束；药味以 JSON 数组存（`database.py:328-343`） |

`items_json` 里每味药：`{herb_name, amount, unit, role, cooking_method}`，`role`（君臣佐使）与 `cooking_method`（煎法）是白名单清洗后写进 JSON 的（`database.py:345-357`、`1784-1819`）。

**接口**：

| 方法 | 路径 | 实现 | 备注 |
| :-- | :-- | :-- | :-- |
| GET | `/api/herbs` | `main.py:1091-1093` → `1682-1688` | 带 `is_low` |
| GET | `/api/herbs/low` | `main.py:1096-1098` → `1746-1752` | 低库存 |
| POST | `/api/herbs` | `main.py:1101-1104` → `1691-1707` | upsert（按老师+药名） |
| POST | `/api/herbs/batch-deduct` | `main.py:1107-1112` → `1755-1777` | 批量扣减 |
| POST | `/api/herbs/{id}/adjust` | `main.py:1115-1123` → `1710-1729` | delta 正入负出 |
| DELETE | `/api/herbs/{id}` | `main.py:1126-1131` → `1732-1743` | **硬删** |
| GET | `/api/herbs/search` | `main.py:1160-1163` → `1862-1874` | 首字联想 |
| POST | `/api/prescriptions` | `main.py:1166-1175` → `1877-1901` | 开方（当面扣库存） |
| GET | `/api/prescriptions` | `main.py:1178-1181` → `1921-1944` | 药方列表 |

**前端**：管理页「💊 中药材库存」表（`App.tsx:3927-3967`）+ 新增/调整弹窗（`3969-3997`）；诊室「开方九宫格」（`4613-4660`）；保存逻辑 `handleSavePrescription`（`1170-1215`）。

### 6.2 关键流程（按代码实际）

```
当面诊疗开方：
  九宫格（只列已有库存药材）→ 点选 → 每味填克数/君臣佐使/煎法
  → 前端校验：至少一味、amount 是 >0 的数字、药名非空（App.tsx:1176-1182）
  → POST /api/prescriptions {teacher_name, patient_name, items, note, is_remote}
      → sanitize_prescription_items()（白名单清洗 role / cooking_method）
      → 非远程：batch_deduct_herbs()
          ① 逐味 SELECT 库存 → 任一不足/不存在 → 立即 return 失败（不做任何修改）
          ② 全部通过 → 逐味 UPDATE stock_amount = 检查时库存 - 本味用量
          ③ COMMIT（连接 A 关闭）
      → 成功后才另开连接 B：INSERT prescriptions(items_json) → COMMIT
  → 前端：data.error ? alert : 清表单 + fetchHerbs() + alert("药方已保存，库存已扣减")

远程诊疗：is_remote=1 → 跳过①②，只写药方。
调整库存：SELECT 当前值 → 计算 new = current + delta → new<0 则 400 → UPDATE。
```

### 6.3 已有的防错

| 已有防错 | 位置 | 说明 |
| :-- | :-- | :-- |
| 批量扣减"先全查、后统一扣" | `database.py:1755-1777` | 应用层的 all-or-nothing，避免"扣了一半失败" |
| 单条调整不允许负库存 | `database.py:1719-1722` → 400 | 明确报错 |
| `UNIQUE(teacher_name, herb_name)` | `database.py:1670` | 防同老师重复建档 |
| 低库存预警 | `database.py:1678`、`1746-1752` | `stock <= warn_threshold` |
| 九宫格只暴露已有库存药材 | `App.tsx:1165-1168` | 正常路径下开不出"库里没有的药" |
| 前端克数 > 0 校验 | `App.tsx:1176-1181` | 仅前端 |
| 扣减失败保留表单 | `App.tsx:1201-1202` | 不丢老师输入 |
| 君臣佐使 / 煎法白名单清洗 | `database.py:1788-1819` | 脏值落空串，不报错 |
| 远程不扣库存 | `database.py:1886` | 符合"学生自采"语义 |
| 模板里"未入库药材"黄字提醒 | `template_service.py:856-892` | 200 + warnings，不阻断 |

### 6.4 缺失的防错

| 编号 | 缺失项 | 风险 | 证据 | 后果 |
| :-- | :-- | :-- | :-- | :-- |
| **INV-01** | **扣库存与写药方跨连接、跨事务**：`batch_deduct_herbs()` 自己 commit 并关连接，`create_prescription()` 之后才另开连接 INSERT；INSERT 失败（锁/磁盘/字段）→ 库存已扣、药方不存在、无补偿 | **高** | `database.py:1886-1897`（先 `deducted = batch_deduct_herbs(...)`，后 `conn = get_connection()` + INSERT） | 老师看到"保存失败"重试 → 再扣一次；库存凭空蒸发，且没有任何记录能证明扣过 |
| **INV-02** | **同一药方重复药味 → 少扣**：检查阶段把每味药当时的 `stock_amount` 缓存进 `checked`，扣减阶段用同一个旧值算 `new_amount`，后一味覆盖前一味 | **高** | `database.py:1769`（存 `row["stock_amount"]`）、`1772-1774`（用缓存的 `current_amount` 覆盖写） | 甘草 100 克，方子写「甘草 30 + 甘草 30」→ 只扣 30。前端九宫格天然去重，但 API/模板/导入可造 |
| **INV-03** | **数量无语义校验**：`amount` 允许负数 / 0 / NaN；负数量时 `stock < amount` 恒为假 → 通过，`new = stock - (-5)` → **库存反而增加** | **高** | `main.py:1084-1086`（`HerbBatchDeductInput.items: list`，裸 list）、`1136-1148`（`PrescriptionItem.amount: float`，无 `gt=0`）、`database.py:1766`、`1773` | 一条构造请求即可无限加库存；也可用 0 克"空方"绕过扣减 |
| **INV-04** | **无库存流水 / 批次 / 操作者**：只保留最终值 + `updated_at`，没有 in/out 台账 | **高** | `database.py:1670`（表结构）、`1710-1729`、`1755-1777`（都是直接 UPDATE 最终值） | 无法对账、无法追责、无法回滚；"少了 300 克"永远查不清 |
| **INV-05** | **开方无作废 / 撤销 / 退方**：全库无 prescriptions 的 DELETE/void；退方、改远程、抓错药都不回补库存 | **高** | `main.py:1166-1181` 只有 POST/GET；`whitepaper-v2.1.md:689-693` 设想"老师可撤销/纠正"（文档证据，未实现） | 扣错了只能手工"调整库存 +300"，且这次调整不留任何业务理由 |
| INV-06 | `adjust_herb` 读-改-写非原子：SELECT（1714）→ 计算（1719）→ UPDATE（1724），并发两次出库丢更新；连接无 `busy_timeout`/WAL | 中 | `database.py:1710-1729`、`10-13` | 两个窗口同时调整，少记一次 |
| INV-07 | `delete_herb` **硬删**，而历史药方只存药名字符串 → 删档后历史不可解析、不可对账 | 中 | `database.py:1732-1743`、`1895-1896`（`items_json`） | 库存表与历史处方永久失联 |
| INV-08 | `upsert_herb` 允许负库存/负阈值；`SELECT` 后 `INSERT` 的竞态会在 UNIQUE 上抛 `IntegrityError` → 500；前端空值静默按 0 / 50 兜底，"没填"与"填 0"不可区分 | 中 | `database.py:1695-1702`；`App.tsx:1072-1079` | 500 无提示；0 库存被当成"已入库" |
| INV-09 | 业务失败仍 200：`batch-deduct` 失败返回 `{"message":"扣减失败…"}`；`prescriptions` 失败返回 `{"error"}` | 中 | `main.py:1107-1112`、`database.py:1889-1890` | 客户端按状态码判断即误判成功 |
| INV-10 | **金额与库存零关联**：开方不产生收费、扣费不联动库存，无"处方-收费-库存"三方对账；财务自身也是读改写 | 中 | `main.py:1166-1175`（开方不碰 accounts）、`database.py:1614-1632`（余额读改写） | 收钱与发货两套账，无法核对 |
| INV-11 | 单位只是字符串，不参与换算（克/剂/包混用），扣减直接做减法 | 中 | `database.py:1670`（`unit TEXT`）、`1773` | 单位换错即数量级错误 |
| INV-12 | 无批号/效期/产地/入库价；无盘点、无阈值批量设置 | 低 | 表结构只有 6 个业务列（`1670`） | 只能做"大概记个数" |
| INV-13 | 药材名无规范化（甘草/生甘草/炙甘草 是三种；`search` 只看首字） | 低 | `database.py:1862-1874` | 同药多名导致库存分散、预警失真 |

### 6.5 对 Aster-Ai v2 的可复用点与建议

**能搬：**

- `UNIQUE(owner_id, herb_name)` 的建档口径与 upsert 语义。
- **九宫格"只列有库存药材"**的交互（`App.tsx:1165-1168, 4642-4652`）——它天然阻止了"开不存在的药"，是旧版最有效的库存防错。
- **远程不扣库存**的语义与 `is_remote` 0/1。
- 君臣佐使 / 煎法白名单（`PRESCRIPTION_ROLES` / `PRESCRIPTION_COOKING_METHODS`，`database.py:1784-1785`）——中医语义可以直接进 v2 的处方模型。
- 低库存视图与"未入库药材只警告不阻断"的产品判断（`template_service.py:856-892`）。

**必须重做（v2 的核心改造）：**

1. **库存变动一律记流水**：`stock_movement(id, herb_id, delta, reason, ref_type, ref_id, actor_id, idempotency_key, created_at, balance_after)`；当前库存 = 流水汇总或物化余额 + 乐观锁版本号。这一条同时解决 INV-01/02/04/05/10。
2. **扣减与处方同事务**：`BEGIN → 逐味 SELECT … FOR UPDATE / 条件 UPDATE(where stock>=need) → INSERT prescription → COMMIT`；任一失败整体回滚。
3. **数量强校验**：`amount > 0`、`Decimal`、单位换算表、单味上限、总味数上限；对重复药味做 merge 而不是覆盖。
4. **处方状态机**：`draft → issued → (dispensed | voided)`；`void` 产生反向流水（而不是直接改数）。
5. **处方-收费-库存三方关联**：处方金额由药味 × 单价计算，收费单引用处方 id，任何一方冲销都要联动。

**不能搬：**

- `items_json` 存药味：无法 join、无法统计、无法加约束、无法做"某味药本月用量"报表；v2 必须是 `prescription_item` 子表。
- 直接 UPDATE 最终库存（无流水）。
- `DELETE /api/herbs/{id}` 硬删（历史处方会指空）。

### 6.6 证据

- `backend/database.py:1664-1672`：`herb_inventory` DDL（`UNIQUE(teacher_name, herb_name)`）。
- `backend/database.py:1675-1688`：`is_low` 与列表。
- `backend/database.py:1691-1707`：upsert（SELECT 后 INSERT/UPDATE，无入参校验）。
- `backend/database.py:1710-1729`：调整（读改写；负数拦截）。
- `backend/database.py:1732-1743`：硬删。
- `backend/database.py:1746-1752`：低库存。
- `backend/database.py:1755-1777`：批量扣减（检查与扣减都基于缓存的旧值）。
- `backend/database.py:1784-1819`：君臣佐使/煎法白名单与清洗。
- `backend/database.py:1862-1874`：首字联想。
- `backend/database.py:1877-1901`：开方（先扣库存 → 另开连接写方）。
- `backend/database.py:328-343`：`prescriptions` DDL。
- `backend/main.py:1070-1131`：库存四端点（失败 200）。
- `backend/main.py:1134-1181`：开方入参（`amount: float` 无下界）与端点。
- `frontend/src/App.tsx:1054-1130`：库存拉取、保存、调整、删除。
- `frontend/src/App.tsx:1170-1215`：开方校验与提交（前端拦负数，后端不拦）。
- `frontend/src/App.tsx:3927-3997`：库存表与两个弹窗。
- `frontend/src/App.tsx:4613-4660`：开方九宫格（远程开关、库存提示）。
- `backend/template_service.py:856-892`：未入库药材 warnings。

---

## 7. 模块四：学生档案

### 7.1 功能现状

学生档案在旧版是**四张表拼出来的**，没有单一"档案"实体：

| 表 | 内容 | 位置 |
| :-- | :-- | :-- |
| `patients` | `name(PK), guardian_name, relation, created_at, last_active_at` | `database.py:137-143`、`430-434` |
| `patient_profiles` | `patient_name(PK), gender, birth_date, birth_time, birth_place, location` | `database.py:157-166` |
| `patient_records` | 病历（AI 草案 / 老师终稿 / 医生 / 就诊时间） | `database.py:207-222` |
| `patient_teachers` | 师生关系 + `status` + `lineage_id` | `database.py:147-154` |

**接口**：

| 方法 | 路径 | 实现 | 说明 |
| :-- | :-- | :-- | :-- |
| GET | `/api/patient-profile` | `main.py:294-325` | 读档案；有生日就现算八字/五行 |
| POST | `/api/patient-profile` | `main.py:327-331` → `database.py:604-622` | 合并写入 |
| GET | `/api/health-trend` | `main.py:333-397` | 五行/脏腑倾向 |
| GET | `/api/patients` | `main.py:268-270` | 按监护人过滤 |
| POST | `/api/patients/add` | `main.py:272-277` → `database.py:571-586` | 亲友建档 |
| DELETE | `/api/patients/{name}` | `main.py:289-292` → `database.py:588-594` | **8 表硬删** |
| GET | `/api/patient-records` | `main.py:891-894` | 病历历史 |
| GET | `/api/export/patient` | `export_api.py:58-91` | 全量导出（flag 默认 off） |

**前端**：学生端「亲友/档案」卡片（`App.tsx:2181-2220` 增删、`3501-3575` 编辑）；老师端「📋 基础档案（供辨证参考）」（`3896-3910`）。

### 7.2 关键流程（按代码实际）

```
建档：学生点「添加亲友」
  → 前端校验：家庭 ≤5 人、姓名/关系/性别/生日必填、同名拦截、父母生日须早于本人
  → POST /api/patients/add
      → INSERT OR IGNORE patients(... created_at="2026-09-16")   // 硬编码
      → UPSERT patient_profiles（全字段覆盖）

改档：POST /api/patient-profile
  → save_patient_profile() 合并策略：
      gender/birth_date/birth_time/birth_place：新值为空则保留旧值（清不掉）
      location：直接取新值（空即清空）

读档：GET /api/patient-profile
  → 无行 → 返回全空默认对象（200，不是 404）
  → 有 birth_date → cnlunar 算八字/五行；异常 → 返回"推算失败"文案

删除：老师/学生点删除 → confirm → DELETE /api/patients/{name}
  → 循环 8 张表 DELETE（patients / patient_teachers / patient_profiles / homework /
    transcriptions / drafts / patient_records / points_accounts）
```

### 7.3 已有的防错

| 已有防错 | 位置 | 说明 |
| :-- | :-- | :-- |
| 一位学生最多 3 位老师 | `database.py:516-530` | 应用层计数 |
| 一位学生最多 5 位家庭成员 | `App.tsx:2182` | 仅前端 |
| 同名家属拦截 | `App.tsx:2186` | 仅前端 |
| 父母生日必须早于本人 | `App.tsx:2187-2192` | 仅前端 |
| 本人档案不可删 | `App.tsx:2215` | 按当前身份判断（D-059 修复了写死"张三"） |
| 缺生日时明确"无法推算" | `main.py:322-324` | 不瞎算 |
| 删除前 confirm | `App.tsx:2216` | 仅前端，后端无二次确认 |
| 师生关系有 `status`，可软解除 | `database.py:554-559` | 与"删档案"是两条路径 |

### 7.4 缺失的防错

| 编号 | 缺失项 | 风险 | 证据 | 后果 |
| :-- | :-- | :-- | :-- | :-- |
| **PRF-01** | **全局物理硬删**：一次 `DELETE` 跨 8 张表、不分师门、无身份、无软删/墓碑/回收站/审计 | **高** | `database.py:588-594`；`main.py:289-292`；与设计「删除 = tombstone 标记」（`docs/phase2-data-sovereignty-design.md:201-209`、`650-651`）相反；裁决文件自己列了这条冲突（`team/decisions/ruling-2026-10-04-数据主权与归档封存.md:83`） | 老师端一次误操作即可销毁学生的病历、转述、草案、积分；不可恢复；"数据主权归患者"的承诺反被老师执行 |
| **PRF-02** | **无鉴权读档**：知道姓名即可读任意学生的档案、病历、药方，甚至导出全量 | **高** | `main.py:294-331`、`891-894`；`export_api.py:48-91`（`patient_name == patient_id` 即通过） | 病人隐私（含出生地/居住地/病历）可被枚举；导出含该生在所有老师名下的病历 |
| PRF-03 | 合并语义**不对称**：`gender/birth_*` 传空保留旧值（改不掉），`location` 传空即清空（易误删）；无 PATCH 语义、无字段级意图 | 中 | `database.py:608-615` | "我想清空错误的出生地"做不到；"我只想改现居地"却把现居地清空 |
| PRF-04 | 出生信息**可改且无版本/审计**：一改 `birth_date`，八字、五行、体质结论全部变，旧结论不可追溯 | 中 | `database.py:604-622`；`main.py:296-321`（每次现算） | 同一学生两次打开看到两套体质结论，病历里引用的旧结论对不上 |
| PRF-05 | **零字段校验**：`birth_date` 任意字符串（可未来、可 `2026-13-45`）、`gender` 任意、姓名无长度/字符限制 | 中 | `main.py:132-148`（全是 `str`） | 脏数据 → `strptime` 异常 → 前端只看到"推算失败" |
| PRF-06 | 监护关系只是**标签**：`guardian_name` / `relation` 无授权记录、无监护人确认、未成年人无额外保护 | 中 | `database.py:137-143`；`docs/development-plan-v1.md:63` 标注监护模式"数据独立存储未实现"（文档证据） | 谁都能把任意人登记为"儿子"；合规上缺少监护人同意链路 |
| PRF-07 | **静默兜底**：档案不存在返回全空对象而非 404 | 中 | `database.py:596-602` | 调用方无法区分"没建档"与"建档了但全空"；也掩盖了"姓名写错" |
| PRF-08 | `created_at` 硬编码 `"2026-09-16"` | 低 | `database.py:574` | 建档时间永远是 2026-09-16 |
| PRF-09 | 身份即姓名：同名即同人，改名即断链 | 低 | `database.py:137`（`name TEXT PRIMARY KEY`）；`docs/audit-2026-10-15.md:123-132`（文档证据） | 两个"张伟"无法共存 |
| PRF-10 | 导出接口默认 off、前端无入口 | 低 | `export_api.py:41-45`（`EXPORT_ENABLED` 默认 off）；前端 grep `/api/export` 0 命中 | 数据主权承诺里的"可随时导出"实际不可用 |

### 7.5 对 Aster-Ai v2 的可复用点与建议

**能搬：**

- **档案字段分组**（身份 / 出生四要素 / 居所）+「八字五行**派生不落库**、每次现算」的做法——避免把可推导的结论写死进档案。
- **亲友关系模型**（`guardian_name` + `relation`）与"家庭 ≤5 人、父母生日早于本人"的前端校验（`App.tsx:2182-2192`）——规则可以直接做成 v2 的表单校验器。
- **缺生日不推算**的 fail-soft 文案（`main.py:322-324`）。
- **导出 bundle 的 14 键形状**（`export_api.py:62-64, 76-91`）——作为 v2 数据可携带格式的起点很好。

**必须重做：**

1. **稳定 ID**：`patient_id(UUID)` + 姓名仅显示；所有外键改 ID。
2. **删除流程**：删除申请 → tombstone（保留最小标识 + 删除原因）→ 可恢复窗口 → 物理清除（含导出副本告知）。老师端只能"解除师生关系"，不能删学生档案。
3. **字段级变更历史**：谁、何时、旧值→新值；出生信息变更需二次确认（说明会影响体质推算）。
4. **读权限**：学生只能读自己（及被监护者），老师只能读"存在有效师生关系"的学生；导出需学生本人授权。
5. **监护人同意**：未成年人建档必须有监护人确认记录（谁、何时、范围）。

**不能搬：**

- 以姓名为主键、以外键指向姓名。
- 跨 8 表硬删。
- 档案不存在返回空对象（v2 用 404/204 明确语义）。

### 7.6 证据

- `backend/database.py:137-166`：`patients` / `patient_teachers` / `patient_profiles` DDL。
- `backend/database.py:205-222`：`patient_records`（含 `visit_at` 补列）。
- `backend/database.py:516-530`：学生最多 3 位老师。
- `backend/database.py:533-552`：老师拉学生（`INSERT OR IGNORE` + 初始 100 积分）。
- `backend/database.py:561-586`：患者列表、建档（`574` 硬编码日期）。
- `backend/database.py:588-594`：**8 表硬删**。
- `backend/database.py:596-602`：档案不存在返回空对象。
- `backend/database.py:604-622`：合并写入的不对称语义。
- `backend/main.py:268-331`：患者/档案端点（含 DELETE）。
- `backend/export_api.py:48-91`：导出（身份自报、全量 14 键）。
- `frontend/src/App.tsx:2181-2220`：家庭建档与删除（前端校验 + confirm）。
- `frontend/src/App.tsx:2153-2160`：档案保存（不看 `res.ok`、无校验）。
- `frontend/src/App.tsx:3501-3573`：档案编辑（性别/生日/时辰/出生地/现居地）。
- `frontend/src/App.tsx:3896-3910`：老师端只读档案 + 八字/五行。
- `docs/phase2-data-sovereignty-design.md:201-209`、`650-651`：设计口径"删除 = tombstone"（文档证据）。
- `team/decisions/ruling-2026-10-04-数据主权与归档封存.md:83`：裁决文件对硬删的记录（文档证据）。
- `docs/audit-2026-10-15.md:44`、`59`：阅后即焚未实现、硬删仍存在（文档证据）。

---

## 8. 模块五：老师引导（onboarding）

### 8.1 功能现状

**后端只有一个动作**：`POST /api/teachers/onboard`（`teacher_service.py:174-177`）→ `onboard_teacher()`（`80-171`）：

1. `name.strip()` 非空校验；
2. `teacher_id` 与 `name` **双因子一致**校验（阶段一唯一身份校验，`96-103`）；
3. 查 `teachers`，无则 `INSERT`（`name/description/status/last_active_at/created_at`）；
4. 调 `lineage_service.create_lineage()` 建默认师门；失败**只进 warnings，不回滚老师行**（`147-163`）；
5. 返回 `{teacher, teacher_created, lineage, lineage_created, warnings}`。

**前端**：`TeacherOnboarding.tsx`（161 行），挂在设置页「分区⓪ 老师入社区」（`App.tsx:3591-3602`）；列表 + 添加 + "切为当前"。

**没有的东西**：没有账号、没有密码/验证码、没有邀请或审核、没有"引导步骤"（资料→排班→模板→首位学生）、没有完成度、没有停用/注销、没有审计。

### 8.2 关键流程（按代码实际）

```
前端填姓名/简介 → trim 非空 → POST {name, teacher_id: name, description}
  → 后端 strip + 一致性校验
  → teachers 查无此人 → INSERT（status=active）
  → create_lineage(teacher, teacher, None)
      成功 → lineage_created=true
      LineageError（如 LINEAGE_ENABLED 未开）→ warnings 追加一句"老师行已创建但师门未创建"
  → 返回；前端 alert（含 warnings），刷新老师列表，可选"切为当前"
```

### 8.3 已有的防错

| 已有防错 | 位置 | 说明 |
| :-- | :-- | :-- |
| **幂等** | `teacher_service.py:118-140` | 同名重复提交不建第二行，返回 `created=false` |
| 双因子一致性 | `96-103` | 参数写错立即 409 |
| **部分成功不伪装** | `155-163` | 师门失败进 `warnings`，不吞、不回滚老师行 |
| DB 异常 rollback + 503 | `141-143` | 写失败明确报错 |
| 表缺失 → 503 | `112-116` | "请先跑迁移 / 初始化" |
| 前端防重复提交 | `TeacherOnboarding.tsx:47, 150-156` | `submitting` 禁用按钮 |
| 入社区后可切为当前身份 | `TeacherOnboarding.tsx:121-126` | 闭环到身份切换 |

### 8.4 缺失的防错

| 编号 | 缺失项 | 风险 | 证据 | 后果 |
| :-- | :-- | :-- | :-- | :-- |
| **ONB-01** | **无鉴权，且"同名即同人"**：任何人可把任意姓名放进社区；两个真人都叫"张伟"会被静默合并成一位老师 | **高** | `teacher_service.py:118-140`（查到即复用，无冲突提示）；`main.py:105` 无任何依赖 | 冒名/撞名无法区分；"入社区"不是准入，是自助注册 |
| **ONB-02** | **没有引导流程**：入社区后不建 `teacher_settings`（排班仍走硬编码默认）、不建模板、不拉首位学生、无 checklist、无完成度 | **高** | `teacher_service.py` 全文只有建老师 + 建师门；默认排班回落见 `database.py:1327-1345` | 新老师进来看到的是空首页 + 一堆"只读占位"，第一周只能靠人工带 |
| ONB-03 | 姓名零格式校验（只 strip）：可写超长、控制字符、纯符号 | 中 | `teacher_service.py:92-94` | 脏主键（姓名即 PK）终身带着 |
| ONB-04 | 无审核/准入：邀请制只作用于学生（`invites`），老师侧零门槛 | 中 | `main.py:903-917`（邀请码仅学生） | 社区质量承诺无法落地 |
| ONB-05 | 无停用/注销：`teachers.status` 存在但无接口改 | 中 | `database.py:125-133`（有 `status`）、`450-454`（只读 active） | 只能改库；离职老师的号源/学生无法优雅退出 |
| ONB-06 | 无审计：谁在何时把谁放进社区，只有 `created_at` | 中 | `teacher_service.py:127-133` | 无法追责 |
| ONB-07 | 前端只有 `alert`，无步骤进度、无失败重试入口（warnings 弹一次就没了） | 中 | `TeacherOnboarding.tsx:73-86` | "师门没建成"这条 warning 关掉即丢 |
| ONB-08 | 简介无长度限制；无擅长科目/执业信息/头像/联系方式 | 低 | `teacher_service.py:43-55` | v2 的"老师名片"要从零加 |

### 8.5 对 Aster-Ai v2 的可复用点与建议

**能搬：**

- **幂等语义**（重复提交 = 同一个人，返回 `created=false`）。
- **"部分成功不伪装成功"的 warnings 契约**——这是旧版最值得学的工程态度（`teacher_service.py:155-163`）。
- **师门创建复用单一服务**，不在 onboarding 里复制一份逻辑（`151`）。
- **双因子一致性**的思路可以升级成 v2 的"token subject 与路径 owner 必须一致"检查。

**必须重做：**

1. **真注册**：手机号/邮箱 + 验证码或邀请码；`teacher_id` 由系统生成，姓名仅显示；同名 → 409 让人工区分。
2. **引导向导**（4 步，可跳过但记完成度）：`资料 → 排班 → 模板 → 首位学生`；每步写入"完成事件"，首页显示"还差 2 步"。
3. **准入与状态**：`pending → active → suspended`；停用要处理号源（批量取消/转交）与学生归属。
4. **审计**：谁批准、谁邀请、何时生效。

**不能搬：**

- 以姓名为身份与主键。
- "无审核自助入社区"。
- `alert` 式反馈与一次性 warnings。

### 8.6 证据

- `backend/teacher_service.py:1-20`：模块说明（"teachers 原先只有种子数据，无任何创建入口"）。
- `backend/teacher_service.py:36-55`：错误码表与入参模型。
- `backend/teacher_service.py:80-171`：`onboard_teacher()` 全流程（幂等、双因子、warnings）。
- `backend/teacher_service.py:174-177`：唯一端点。
- `backend/main.py:101-105`：路由挂载说明（"无 feature flag"）。
- `frontend/src/TeacherOnboarding.tsx:1-14`：设计取舍（独立文件、只负责入社区）。
- `frontend/src/TeacherOnboarding.tsx:58-87`：提交与 alert 反馈。
- `frontend/src/App.tsx:3591-3602`：挂载位置（设置页最前）。
- `frontend/src/identityBootstrap.ts:56-112`：进入系统时"当前是谁"的解析（从列表取第一个，非登录）。
- `docs/audit-2026-10-15.md:247`：无鉴权的范围外记录（文档证据）。
- `team/decisions/decision-log.md:479-488`：D-020（文档证据）。

---

## 9. 模块六：模板工作室

### 9.1 功能现状

**这是旧版做得最完整的一块**，也是唯一有"契约文档 + 迁移 + 测试 + 前端独立组件 + feature flag"的功能。

**数据表** `templates`（`alembic/versions/0001_create_templates.py:34-48`）：

```sql
id, type, lineage_id, teacher_id, name, schema_json, version,
parent_template_id, status, created_at, updated_at
-- 索引：idx_templates_scope / idx_templates_lineage
-- 硬约束：uq_templates_active_one ON (lineage_id, teacher_id, type) WHERE status = 'active'
```

**四类模板**：`inquiry`（问诊）/ `record`（病历）/ `treatment`（施治）/ `prescription`（开方），每类有独立的 `schema_json` 契约与默认骨架（`template_service.py` 顶部常量）。

**9 个接口**（`template_api.py`，前缀 `/api/templates`）：

| 方法 | 路径 | 作用 | 关键防错 |
| :-- | :-- | :-- | :-- |
| GET | `/api/templates` | 列表 + counts | flag / 身份 / 师门 |
| GET | `/{id}` | 详情 + 版本链 | `_load_owned` 404/403 |
| GET | `/active` | 生效模板 | 声明在 `/{id}` 之前，避免被吃 |
| POST | `/api/templates` | 新建草稿 | 同 scope 复用（200 + `reused`） |
| PUT | `/{id}` | 改草稿 | 非 draft → 409 |
| POST | `/{id}/publish` | 发布 | 发布级校验 + 同事务归档旧 active |
| POST | `/{id}/archive` | 归档 | 幂等 `changed=false` |
| POST | `/{id}/activate` | 重新启用 | 同 publish 事务 |
| POST | `/{id}/derive` | 派生新版本 | 5 条强校验 + 同链复用草稿 |

**前端** `TemplateStudio.tsx`（1,476 行）：四类页签、四套表单、实时预览、版本链、前端同构校验。挂载在老师端「管理」页签（`App.tsx:3912-3920`）。

**生成侧接入**：生成草案前取该老师 active `record` 模板 → 段落骨架提示（`main.py:694-721`；`template_service.py:942-959`）；旧 `plan_templates` 单文本通道保留，并**单向双写**到 `templates`（`template_service.py:962-1034`）。

### 9.2 关键流程（按代码实际）

```
挂载：GET /api/templates?type=inquiry
  → 404 templates_disabled → 不渲染（flag off）
  → 503 template_store_unavailable → 卡内红字
  → 200 → 渲染列表

新建：POST /api/templates {identity, type}
  → 同 scope 有 draft → 复用（reused=true, HTTP 200）
  → 否则 INSERT version = 链内 max+1, status=draft（HTTP 201）

编辑：前端 validateDraft（全量边界）→ PUT /{id} {name, schema_json}
  → 非 draft → 409 template_published_immutable
  → 前端捕获该码 → 自动走 derive 并提示"已为你开启修订版"

发布：前端发布级校验（至少 1 必问 / 1 留待老师…）
  → 已有其他 active → confirm 二次确认
  → 编辑器有未保存改动 → 先 save 再 publish
  → POST /{id}/publish
      事务内：旧 active → archived → 本行 → active → COMMIT
      IntegrityError → 409 template_active_conflict（"请重试"）
      changed 才写 learning event（template_configured）

生成：get_active_record_template(teacher)
  → flag off / 表缺失 / 无 active / schema 版本不符 / 读库异常 → 一律 None → 走旧路径
```

### 9.3 已有的防错（旧版最佳实践）

| 已有防错 | 位置 | 说明 |
| :-- | :-- | :-- |
| 字段级白名单校验，非法值 **400 且不清洗** | `template_api.py:127-136`；`template_service.py:442-530` | 与库存"清洗成空串"策略相反，模板选择"拒收" |
| **草稿级 / 发布级两档校验** | `template_api.py:127-133` | 草稿允许半成品，发布必须完整 |
| 64 KB schema 上限 | `_validated_schema` → `serialize_template_schema` | `schema_too_large` |
| 归属校验：不存在 404、他人 403 | `template_api.py:117-124` | 不回他人行内容 |
| 身份双因子 | `template_api.py:82-87` | `teacher_name` 必须等于 `teacher_id` |
| **状态机**：published/archived 不可原地改 | `template_service.py:682-716` | 409 → 前端转 derive |
| **DB 级唯一 active** | `0001_create_templates.py:58-59` | 部分唯一索引，并发兜底 |
| **同事务切换**（先归档后置新） | `template_service.py:729-769` | 不会出现"scope 无 active"空窗 |
| **幂等**：create 复用 draft / archive 幂等 / derive 复用 | `579-604`、`772-789`、`828-830` | 重复提交不产生第二份草稿 |
| 版本单调 | `792-853`（`max(父+1, 链内 max+1)`） | 归档草稿占号也不会重复 |
| 父版本 5 条强校验 | `792-827` | 跨老师/跨师门/跨类型/自引用/未来版本全拒 |
| 前端同构校验 | `TemplateStudio.tsx:961-1043` | 与后端同一边界，省一次往返 |
| 发布前自动先存 | `TemplateStudio.tsx:1254-1261` | 防"发布的是旧内容" |
| 同类型已有 active 二次确认 | `TemplateStudio.tsx:1249-1253` | 明示"旧版将归档，历史病历不受影响" |
| 缺库存药材 200 + warnings | `template_service.py:856-892` | 不阻断（老师可先配模板后补货） |
| flag 默认 off + 每次请求现读 | `template_api.py:62-79` | 灰度安全 |
| 兼容旧接口一行不改 | `main.py:634-647`；`template_service.py:962-1034` | 旧链路 1:1 |

### 9.4 缺失的防错

| 编号 | 缺失项 | 风险 | 证据 | 后果 |
| :-- | :-- | :-- | :-- | :-- |
| **TPL-01** | 关闭编辑器**不提示未保存**：`取消/關閉` 直接 `setPanel(null)`，丢弃 `draftSchema` | 中 | `TemplateStudio.tsx:846`（按钮）、`1435`（`onClose`）；全文无 `beforeunload` / dirty 提示 | 老师改了 20 分钟，点"取消"即归零 |
| **TPL-02** | 写操作**无审计**：`templates` 无 `updated_by`；learning event 只覆盖状态切换且是 best-effort | 中 | `template_service.py:682-716`（只有 `updated_at`）；`template_api.py:268-279`（仅状态变更记事件） | "谁把病历模板改空了"查不到；内容修改完全无痕 |
| **TPL-03** | 身份仍是**自报**：`teacher_name == teacher_id` 只防参数写错，不防冒充 | 高（横切 X-01） | `template_api.py:82-87` | 任何知道老师姓名的人可读写其全部模板（含发布） |
| TPL-04 | **draft 无唯一约束**：`_find_scope_draft` 取"版本最大者兜底"，并发两个 POST 可各建一份草稿 | 中 | `template_service.py:562-568`、`579-604`；DB 只有 active 的部分唯一索引 | 同类型出现两份 draft，后续 derive/publish 语义混乱 |
| TPL-05 | **`writable_by=teacher` 只进提示词**：生成后无后置校验，无法保证 AI 真没填舌象/脉象/辨证/施治 | 中 | `template_service.py:942-959`（拼进 prompt）；`main.py:713-718`（生成） | 宪法级硬约束（"AI 永不填"）实际只靠模型自觉 |
| TPL-06 | legacy 双写**单向 + best-effort**，两表可长期不一致，无对账/告警 | 中 | `template_service.py:962-1034`；`main.py:639-647` | 老师在旧接口改施治模板，新接口看到的是过期草稿（或反之） |
| TPL-07 | 归档不可删、无回收站；误发布只能再发一版纠正 | 低 | `template_api.py:16-17`（明确不提供 DELETE） | 版本链越来越长，老师心智负担高 |
| TPL-08 | 前端校验与后端白名单**两套实现**（常量各写一份） | 低 | `TemplateStudio.tsx:955-1043` vs `template_service.py:442-530` | 边界一改就漂，出现"前端过、后端 400" |

### 9.5 对 Aster-Ai v2 的可复用点与建议

**基本整套可搬（详见第 11 节）**。要点：

1. **schema 契约 + 两档校验**（草稿宽松 / 发布严格）——直接作为 v2 模板域的规格。
2. **状态机 + 部分唯一索引 + 同事务切换**——这三件套是"不会出现两个生效版本"的完整答案。
3. **幂等三处**（create/archive/derive）——重复点击不会产生脏数据。
4. **错误码表**（`_TEMPLATE_ERROR_STATUS`）与统一错误体 —— v2 应把它推广到所有域。
5. **前端"同构校验 + 发布前先存 + 二次确认 + 409 自动派生"**——这套交互值得原样复制到 v2 的模板编辑器。
6. **"未入库药材只警告不阻断"**——产品判断正确（先配模板后补货），v2 保留。

**要补的：**

- 关闭/切换前 dirty 提示（TPL-01）；
- 内容级审计（谁改了哪一段，before/after 摘要）；
- draft 唯一约束（`UNIQUE(scope, type) WHERE status='draft'`）；
- 生成后的**后置校验**：`writable_by=teacher` 的段若被 AI 填了，直接标红并阻断签字（把 prompt 约束变成代码约束）；
- legacy 双写的对账任务或干脆砍掉旧通道。

**不能搬：**

- `teacher_name == teacher_id` 式身份（v2 用 token）。
- flag 默认 off（v2 核心域应默认开，见 11.2）。

### 9.6 证据

- `backend/alembic/versions/0001_create_templates.py:34-60`：`templates` DDL、三个索引（含部分唯一索引）。
- `backend/template_api.py:36-136`：路由、错误码表、flag、身份、师门、归属、校验入口。
- `backend/template_api.py:151-360`：9 个端点（含 publish 的同事务语义与 learning 事件接线）。
- `backend/template_service.py:442-530`：校验层（草稿/发布两档、尺寸）。
- `backend/template_service.py:579-604`：新建/复用草稿。
- `backend/template_service.py:682-716`：只允许改 draft。
- `backend/template_service.py:729-769`：同事务切换 active（先归档后置新，IntegrityError → 409）。
- `backend/template_service.py:792-853`：派生（5 条强校验 + 版本单调）。
- `backend/template_service.py:856-892`：未入库药材 warnings。
- `backend/template_service.py:942-959`：段落骨架（`writable_by=teacher` 标注"留待老师"）。
- `backend/template_service.py:962-1034`：legacy 单向双写。
- `backend/main.py:634-721`：旧 `/api/plan_template` 与生成侧接入。
- `frontend/src/TemplateStudio.tsx:961-1043`：前端同构校验。
- `frontend/src/TemplateStudio.tsx:1215-1350`：保存/发布/归档/重启/派生。
- `frontend/src/TemplateStudio.tsx:846`、`1435`：取消/关闭无 dirty 提示。
- `frontend/src/App.tsx:3912-3920`：挂载点与师门上下文。
- `docs/epic1-template-design-v1.md`（§9–§12）：模板契约设计（文档证据）。

---

## 10. 防错矩阵总表（特别重点）

### 10.1 九类防错 × 六个模块

单元格 = 该模块在该类防错上的**最大残余风险**；`✓` = 该类别已有成体系的实现。

| 防错类别 | 排班/节假日 | 预约 | 库存/开方 | 学生档案 | 老师引导 | 模板工作室 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 输入校验 | **高**（SCH-02/04） | **高**（APT-01） | **高**（INV-03） | 中（PRF-05） | 中（ONB-03） | ✓（两档校验 + 白名单） |
| 权限 / 越权 | **高**（任意改他人排班） | **高**（APT-04 IDOR） | **高**（任意增减/删药） | **高**（PRF-02 任意读/导出/删） | **高**（ONB-01 冒名） | 中（TPL-03 自报身份） |
| 重复提交 / 幂等 | 低（覆盖写） | 中（无幂等键，靠占用检查） | **高**（重试 = 重复扣） | 低（UPSERT） | ✓（幂等） | ✓（三处幂等） |
| 并发 / 竞态 | 中（后写覆盖） | **高**（APT-02 TOCTOU） | **高**（INV-02/06） | 低 | 低 | 中（TPL-04 draft 无唯一） |
| 事务 / 回滚 | — | 无（单表单语句） | **高**（INV-01 跨事务） | 无（硬删不可逆） | 中（部分成功） | ✓（唯一事务点） |
| 金额 / 库存一致性 | — | 中（与收费无联动） | **高**（INV-10 三方不对账） | — | — | 低 |
| 时区 / 日期边界 | 低（SCH-07） | 中（APT-10/12） | 低 | 中（PRF-04 生日可改） | 低 | 低 |
| 软删除 / 审计 | **高**（无审计） | **高**（无审计/无取消人） | **高**（INV-04 无流水） | **高**（PRF-01 硬删） | 中（ONB-06） | 中（TPL-02） |
| 错误提示 | **高**（SCH-01 假成功） | **高**（APT-05 假成功） | 中（INV-09 200 失败） | 中（PRF-07 空对象） | 中（ONB-07 alert） | ✓（错误码 + 明细） |

### 10.2 如果只修 10 条（按"上线会不会出事"排序）

| # | 问题 | 一句话后果 | 证据 |
| :- | :-- | :-- | :-- |
| 1 | **没有身份层**（X-01） | 任何人直连后端即可读写任何人的数据；排班/库存/档案/模板全部不设防 | `main.py:26-34`（CORS `*`、无 Depends）；`decision-log.md:479-488` |
| 2 | **开方扣库存跨事务**（INV-01） | 写药方失败 = 库存白扣，且无记录可查 | `database.py:1886-1897` |
| 3 | **库存数量可负数**（INV-03） | 一条请求把库存"加"到任意值；无单位/重复校验 | `main.py:1084-1086`、`database.py:1766/1773` |
| 4 | **预约不校验排班/节假日/过去**（APT-01） | 日历上看着是空的就敢约，约出来是休息日 3 点 | `database.py:1462-1473` |
| 5 | **预约无状态机 + 无唯一约束**（APT-02/03） | 取消的号能被复活；并发能出双号；取消别人预约只需一个 id | `database.py:1475-1482`、`main.py:1054-1060` |
| 6 | **学生档案 8 表硬删**（PRF-01） | 一次误点销毁病历+转述+草案+积分，不可恢复 | `database.py:588-594` |
| 7 | **排班保存接口是坏的**（SCH-01） | 老师以为改了排班，实际没改；学生照着错排班约 | `main.py:942-970`、`App.tsx:1012-1022` |
| 8 | **失败仍 200 + 前端不看 body**（X-02/APT-05） | 冲突、库存不足、保存失败都显示"成功" | `database.py:1463`、`1889`；`App.tsx:2322-2326` |
| 9 | **无库存流水**（INV-04） | 库存对不上时无法定位任何一次变动 | `database.py:1670`、`1755-1777` |
| 10 | **老师同名即同人**（ONB-01） | 两位"张伟"被合并，学生/排班/库存全部串台 | `teacher_service.py:118-140` |

### 10.3 三类"看起来做了、其实没做"的防错（最危险）

| 表象 | 实际 | 证据 |
| :-- | :-- | :-- |
| 界面上有"预约规则：提前 7 天 / 2 小时可取消 / 余额门限" | 全是**只读占位**，未接后端，服务端零执行 | `App.tsx:3697-3707`、`3877-3878` |
| 有"药材入库"按钮 | `onClick` 是 `alert("药材入库功能开发中")`，真正的入库在另一张表（管理页库存） | `App.tsx:3610` |
| 有"阅后即焚 / 数据主权归患者"的 README 承诺 | 签字只删 `drafts` + `transcriptions`，病历永久留在服务端；全库无擦除逻辑 | `README.md:17-21`；`database.py:1080-1081`；`docs/audit-2026-10-15.md:44` |

---

## 11. 给 Aster-Ai v2 的复用清单

### 11.1 直接搬（低风险、高价值）

| 资产 | 位置 | 为什么能搬 |
| :-- | :-- | :-- |
| **四类模板 schema 契约** | `template_service.py` 顶部常量 + `docs/epic1-template-design-v1.md` §9 | 字段、默认值、边界都写死了，且与前端同构；换成 JSON Schema / Pydantic 即可 |
| **两档校验器** | `template_service.py:442-530` | "草稿宽松 / 发布严格"是正确产品语义，逻辑与存储无关 |
| **状态机 + 部分唯一索引 + 同事务切换** | `template_service.py:729-769`、`0001:58-59` | 解决"同 scope 只能一个 active"的完整答案，DB 兜底不靠应用层 |
| **幂等三处** | `create_or_reuse` / `archive` / `derive`（`579-604`、`772-789`、`828-830`） | 语义清楚（重复提交返回同一对象 + `changed/reused` 标记） |
| **统一错误体与错误码表** | `template_api.py:39-59`；`teacher_service.py:36-61` | `{detail:{error,msg,errors,warnings}}` 可直接作为 v2 全局错误契约 |
| **"部分成功不伪装" warnings** | `teacher_service.py:155-163` | v2 的跨服务编排（建老师+建师门+建排班）都需要这个语义 |
| **`agent_tasks` 请示通道** | `database.py:363-390`、`2065-2139` | "智能体建议 → 老师确认 → 执行 → 写 action_log"的闭环；v2 可直接用于库存补货、批量改约 |
| **导出 bundle 形状** | `export_api.py:76-91` | 14 键覆盖学生全量数据，是 v2 数据可携带（data portability）的现成格式 |
| **前端 dirty-check + 二次确认 + 409 自动派生** | `TemplateStudio.tsx:1244-1279` | 交互层最佳实践，可复制到 v2 所有"发布/生效"动作 |
| **identityBootstrap 纯函数 + vitest** | `frontend/src/identityBootstrap.ts` | 结构（依赖注入 `fetchImpl`、永不抛错、来源可观测）值得保留，只是数据源换成 token |
| **九宫格"只列有库存药材"** | `App.tsx:1165-1168`、`4642-4652` | 用 UI 结构消除一整类错误（开不存在的药） |
| **7 天 × 时段投影接口** | `main.py:1004-1052` | 读模型清晰，前端零计算 |
| **`UNIQUE(owner, herb_name)` + 低库存视图** | `database.py:1670`、`1746-1752` | 简单有效 |

### 11.2 改造后搬

| 资产 | 改造点 | 不能原样搬的原因 |
| :-- | :-- | :-- |
| 模板域整体 | 身份换 token；补 draft 唯一约束；补内容审计；补生成后置校验 | 身份是自报的（`teacher_name == teacher_id`） |
| 错误契约 | 推广到所有域，废除 HTTP 200 失败 | 现在只有模板/学习/导出/师门用真实状态码 |
| feature flag | 保留"现读"机制，**默认值反转**（核心链路默认开） | 旧版 9 个 flag 全默认 off，新环境首启即"功能缺失"（`docs/audit-2026-10-15.md:144-148`） |
| 导出 | 加签名、加审计、加授权（学生本人） | 现在 `patient_name == patient_id` 即放行 |
| 请示通道 | 加"执行前二次校验 + 执行后回执 + 可撤销" | 现在 `resolve_agent_task` 无幂等、无状态检查（`database.py:2065-2103`） |
| 排班模型 | 换结构化时段 + 日期例外表 + 冲突回看 | JSON 字符串存 TEXT 无法约束 |

### 11.3 不能搬（会继承债务）

| 资产 | 原因 | v2 应采用 |
| :-- | :-- | :-- |
| 以姓名为 PK / 外键 | 同名冲突、改名断链、无法做稳定审计 | `user_id` / `patient_id` UUID，姓名仅显示 |
| `items_json` 存药味 | 无法 join/统计/约束（"某味药本月用量"做不了） | `prescription_item` 子表 |
| 每函数自建 SQLite 连接 | 无事务边界、无连接池、无 WAL（X-04） | Unit of Work / 连接池 / 显式事务 |
| `init_db()` + alembic 双轨 | 结构真实状态不可知（X-06） | 只保留迁移工具 |
| HTTP 200 + `{"error"}` | 客户端与监控都无法判断成败（X-02） | 真实状态码 + 机器可读 code |
| `reason` 关键词判远程 | 文案一变分类就错（APT-09） | 枚举字段 `mode` |
| `App.tsx` 单文件 4,816 行 | 139 个 `useState`、无法并行开发 | 按页面/域拆分 |
| `alert()` 交互 | 不可测、不可访问、不可回滚 | Toast + 可重试动作 + 错误详情 |
| "只读占位"卡片 | 让用户以为规则生效（10.3） | 要么做，要么不显示 |
| 库存直接改最终值 | 无法对账（INV-04） | 流水 + 物化余额 |

---

## 12. 建议的落地顺序（v2）

### P0 · 上线阻断项（没有它不能给真人用）

| 项 | 验收标准 | 对应旧版问题 |
| :-- | :-- | :-- |
| 身份层（token/session + 资源归属校验） | 任意跨用户读写返回 403；审计能记录 `actor_id` | X-01、APT-04、PRF-02、ONB-01、TPL-03 |
| 库存：事务 + 流水 + 数量校验 + 作废回补 | 扣减与处方同事务；任意失败库存不变；每次变动有流水与 actor；负数量 400 | INV-01/02/03/04/05 |
| 预约：号源可用性 + 唯一约束 + 状态机 | 休息日/节假日/过去时间 409；并发不出双号；非法状态转移 409 | APT-01/02/03 |
| 档案：软删 + 墓碑 + 恢复窗口 | 老师只能解除关系；删除可恢复；审计留存 | PRF-01 |
| 统一错误契约（真实状态码 + code） | 客户端只按状态码判断即可；监控可按 code 告警 | X-02、APT-06、INV-09 |
| 排班保存链路可验证 | 保存后重读一致；有集成测试 | SCH-01 |

### P1 · 内测前应完成

| 项 | 验收标准 | 对应 |
| :-- | :-- | :-- |
| 业务审计表（who/what/before/after/ref） | 排班、预约、库存、档案、模板的写操作全部留痕 | X-03、SCH-06、TPL-02 |
| 幂等键 | 预约创建、开方、扣费、入社区重复提交结果一致 | 幂等行 |
| 时区策略 | 全库 UTC 存储 + 业务时区展示；"今天"只有一个定义 | X-05 |
| 排班变更回看已约号源 | 改休息日返回受影响列表并要求处置 | SCH-03 |
| 老师引导向导（4 步） | 新老师 10 分钟内能自己完成"资料→排班→模板→首位学生" | ONB-02 |
| 模板生成后置校验 | `writable_by=teacher` 段被 AI 填 → 标红 + 阻断签字 | TPL-05 |

### P2 · 可排期

- 库存批次/效期/产地/入库价 + 单位换算 + 盘点；
- 处方-收费-库存三方对账报表；
- 模板回收站、库存删除改为停用；
- 学生数据导出（含签名与导出审计）；
- 药材同义词/规范化（甘草 vs 生甘草 vs 炙甘草）。

---

## 13. 附录

### 13.1 附录 A：本次确认过的关键文件

| 文件 | 行数 | 读它确认了什么 |
| :-- | :-- | :-- |
| `README.md` | 33 | 产品承诺（阅后即焚 / 数据主权 / 积分本地）与代码现状的落差 |
| `backend/main.py` | 1,370 | 78 个路由；排班重复注册；预约/库存/档案端点；CORS 全开；无鉴权依赖 |
| `backend/database.py` | 3,289 | 17 张表 DDL；排班/预约/库存/档案/模板的全部实现细节；硬删；无事务 |
| `backend/template_api.py` | 360 | 模板 9 端点、错误码表、flag、归属校验 |
| `backend/template_service.py` | 1,035 | 校验层、状态机、版本链、legacy 双写、生成侧骨架 |
| `backend/teacher_service.py` | 177 | 老师入社区（幂等 + warnings） |
| `backend/export_api.py` | 91 | 学生全量导出的身份与范围 |
| `backend/alembic/versions/0001_create_templates.py` | — | 唯一一处业务部分唯一索引 |
| `frontend/src/App.tsx` | 4,816 | 排班/节假日/库存/开方/预约/档案/引导/工作台全部前端逻辑 |
| `frontend/src/TemplateStudio.tsx` | 1,476 | 模板工作室交互与前端同构校验 |
| `frontend/src/TeacherOnboarding.tsx` | 161 | 入社区面板 |
| `frontend/src/identityBootstrap.ts` | 113 | "当前是谁"的解析方式（非登录） |
| `frontend/src/appShared.ts` | 232 | 远程关键词、药材白名单等共享常量 |
| `docs/audit-2026-10-15.md` | 258 | 独立审计（排班重复路由实测、硬删、无鉴权、flag 默认关闭） |
| `docs/development-plan-v1.md` | — | "已完成"清单不含排班/预约/库存 |
| `docs/tech-debt.md` | — | TD-008 无鉴权、TD-005/007 plan_templates 未师门化 |
| `docs/phase2-data-sovereignty-design.md` | — | 删除 = tombstone 的设计口径 |
| `docs/whitepaper-v2.1.md` | — | "预约/库存交给智能体"与"可撤销/纠正"的产品意图 |
| `team/decisions/decision-log.md` | — | D-020 无鉴权为内测前必须项 |
| `team/decisions/ruling-2026-10-04-数据主权与归档封存.md` | — | 硬删冲突已被记录但未修 |

### 13.2 附录 B：本次未验证 / 局限

1. **未运行**：SCH-01 的 422 复现来自 `docs/audit-2026-10-15.md:97-107`，本次只做静态核对（装饰器 + 类 + 重复路由三要素齐全），未启动服务。
2. **未连库**：`zhiheng.db` / `test.db` 未打开。真实数据是否存在"重复时段预约""负库存""同名老师"等脏数据，未核实。
3. **未跑测试**：`backend/test_api.py` 等是否覆盖这些缺陷，本周只做了关键词抽样（排班/节假日接口在测试中 0 命中；库存测试只覆盖正数扣减）。
4. **前端只静态读**：未在浏览器里点过，交互结论来自代码与 `docs/audit-2026-10-15.md` 的实测记录。
5. **模板工作室的测试量很大**（`test_templates.py` 47KB），本次未逐条核对覆盖清单。

### 13.3 附录 C：复核用只读命令

```powershell
# 1) 排班重复路由（应看到两次 @app.post("/api/teacher-schedule")，且第一次紧跟 class）
Select-String -Path backend/main.py -Pattern 'teacher-schedule' -Context 0,2

# 2) 预约表没有唯一索引 / 库存没有流水表
Select-String -Path backend/*.py -Pattern 'CREATE (UNIQUE )?INDEX'

# 3) 全库无鉴权依赖
Select-String -Path backend/*.py -Pattern 'Depends|Authorization|Bearer|session'

# 4) 库存扣减是两次连接
Select-String -Path backend/database.py -Pattern 'def batch_deduct_herbs|def create_prescription' -Context 0,30

# 5) 档案 8 表硬删
Select-String -Path backend/database.py -Pattern 'def delete_patient' -Context 0,8
```

### 13.4 附录 D：术语与文件对照

| 术语 | 在旧版里的实体 |
| :-- | :-- |
| 老师工作时间 / 排班 | `teacher_settings.work_schedule`（周几 → 半小时时段数组） |
| 节假日 | `teacher_settings.holidays`（`YYYY-MM-DD` 字符串数组） |
| 号源 | 一个 30 分钟时段（`ALL_SLOTS` 之一）；一格一号 |
| 预约 | `appointments` 一行，状态 `pending/confirmed/cancelled` |
| 库存 | `herb_inventory` 一行（老师 × 药材） |
| 开方 | `prescriptions` 一行 + `items_json` 里的 N 味药 |
| 学生档案 | `patients` + `patient_profiles` + `patient_records` + `patient_teachers` 的组合 |
| 老师引导 | `POST /api/teachers/onboard`（建老师 + 建师门），无后续步骤 |
| 模板工作室 | `templates` 四类模板 + 9 端点 + `TemplateStudio.tsx` |

### 13.5 附录 E：老师工作台（首页 / 诊室）现状（补充观察，不在 7 项范围内）

工作台不在你给的 7 项清单里，但你点名要读"工作台"相关文档，这里给一段补充观察，供 v2 对照。

**组成**

| 区域 | 内容 | 代码 |
| :-- | :-- | :-- |
| 首页 · 🤖 智能体工作台 | 三区块：待你确认 / 已办汇报 / 行动日志 | `App.tsx:2941-3015`、`1217-1239` |
| 首页 · 🧭 智能体阶段 | 阶段卡（flag off 不渲染） | `App.tsx:3016-3045` |
| 首页 · 📋 今日备忘录 | 时间轴（静态项 + 今日已确认预约）+ 未排期事项 + 明日提示 | `App.tsx:2445-2483`、`3046-3110` |
| 诊室 · 🩺 诊室队列 | 双列（预约面诊 / 远程问诊）+ 搜索 + 临时加插 | `App.tsx:4163-4325` |
| 诊室 · 🩺 诊室工作台 | 现场记录 / 病历草案 / 标签 / 开方 / 施治方案 | `App.tsx:4392-4660` |
| 诊室 · 📝 待处理陈述 | 学生十问歌摘要，点"已处理"移出 | `App.tsx:4325-4390` |

**已有的防错**

- **请示通道"人工确认后才执行"**：智能体只写 `agent_tasks`，老师点 ✅ 才动（`database.py:2065-2103`）——这是旧版最重要的一条"人在环"设计。
- 诊室工作台只取"当前就诊学生"的草案，避免多学生串台（`App.tsx:251`）。
- 切换老师/学生时清空诊室状态（`App.tsx:850-870`）——防串台，代价是未落库输入丢失（注释自认）。
- 待处理陈述接口缺失时显示"暂无 + 待补"灰字，不弹窗不阻塞（`App.tsx:1246-1262`）。
- 今日备忘录"完成"状态存本地、跨天自动清空（`MEMO_DONE_STORE_KEY`）。

**缺失的防错**

| 编号 | 缺失项 | 风险 | 证据 |
| :-- | :-- | :-- | :-- |
| WK-01 | 请示"确认"**无幂等、无状态校验**：`UPDATE agent_tasks SET status=? WHERE id=?` 不看当前 status，重复点击/并发会重复写 `agent_action_log`，`approved` 可再被 `approved` | 中 | `database.py:2081-2088` |
| WK-02 | 工作台三区块是**前端拼三个接口**（`agent_tasks` ×2 + `action_log`），无服务端聚合读模型 | 中 | `App.tsx:1217-1239` |
| WK-03 | 今日备忘录含**写死的演示项**（08:30 吃药提醒、21:00 晚间提醒），真实老师会当成自己的日程 | 中 | `App.tsx:2463-2467` |
| WK-04 | 文案语义错配：`status_label !== '活跃'` 的学生一律写成"未提交周报" | 低 | `App.tsx:2475` |
| WK-05 | 切学生清空未落库输入，无 dirty 提示 | 中 | `App.tsx:850-870` |
| WK-06 | 待确认区块**不按 `category` 过滤**，`agent` 类请示混在学生请示里 | 低 | `database.py:2041-2062`；`docs/epic2-agent-stage-design-v1.md:757`（文档证据） |

**对 v2 的建议**：工作台应收敛为**一个服务端聚合读模型**（如 `GET /workbench?date=` 返回待确认/今日/提醒），前端不再拼三个接口；请示执行加 `idempotency_key` 与 `WHERE status = 'pending'` 条件更新；演示数据一律用 flag 隔离。

---

*报告结束。本报告只读产出，未修改 `D:\projects\zhiheng-tcm` 下任何文件。*
