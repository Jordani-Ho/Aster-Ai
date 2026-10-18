# M1-24 坚持率计算（纯逻辑）

- 状态：已派（Kimi，试用，2026-10-17）
- 依赖：M1-13（作业与打卡，已完成）
- 用途：M1-23a（坚持率界面，DeepSeek）会直接调用本卡的函数。本卡**只写纯函数和测试**，不改界面、不改存储格式、不改病历格式。

## 目标

给定一位学生的作业和打卡记录，算出“连续练了几天”“本周坚持率”“是否该提醒”。

## 范围

新建 `app/src/core/adherence/`（`index.ts`、`adherence.test.ts`、`README.md`）。复用 `app/src/core/homework/` 里已有的 `schedule`、`Checkin`、`Assignment`，不要自己重写排程逻辑。

```ts
export interface AdherenceDay { day: string /* YYYY-MM-DD，设备本地日期 */; scheduled: number; done: number }
export function dailyAdherence(assignments: Assignment[], checkins: Checkin[], from: string, to: string): AdherenceDay[]
export function currentStreak(assignments: Assignment[], checkins: Checkin[], today: string): number
export function weeklyRate(assignments: Assignment[], checkins: Checkin[], today: string): number | null
export function needsNudge(assignments: Assignment[], checkins: Checkin[], today: string): boolean
```

规则：
1. 某天“有作业”= 这一天按排程至少有一条作业（`schedule` 已经处理了生效日期、持续天数、时辰、节气、单次）。
2. 一条作业在某天“完成”= 当天有它的打卡；同一天多次打卡只算一次。
3. `currentStreak`：从 `today` 往回数，**有作业且全部完成**的天连续计数；**没有作业的天跳过**，不算中断也不加一；`today` 当天还没完成时不算中断（从昨天开始数）。
4. `weeklyRate`：含 `today` 在内的最近 7 天，完成的作业条数 ÷ 应完成的作业条数；这 7 天一条作业都没有时返回 `null`。
5. `needsNudge`：最近两个“有作业的日子”（不含今天）都没有全部完成时返回 `true`。
6. 日期一律按设备本地日期（与 M1-13 一致）。夏令时切换那天不能多算或少算一天。

## 验收用例（全部写成测试）

1. 每天一条作业，连续打卡 5 天：`currentStreak` = 5。
2. 中间一天漏打：从漏打那天之后重新计数。
3. 只有每周一次的节气或单次作业时，没作业的日子不打断连续天数。
4. 今天还没打卡：连续天数按到昨天计算，不归零。
5. 同一天打卡 3 次：只算一次。
6. 作业 `durationDays` 到期后的日子不算“有作业”。
7. 7 天里有作业的日子完成率 4/6：`weeklyRate` ≈ 0.667；7 天都没作业：`null`。
8. 最近两个有作业的日子都漏了：`needsNudge` = true；漏一天、补一天：false。
9. 美国夏令时切换周（例如 2026-11-01，用 `TZ=America/Los_Angeles` 跑）里，`dailyAdherence` 每天恰好一条记录，没有重复或缺失的日期。
10. 输入里有格式不对的打卡（`at` 不是合法时间）：忽略这一条，不抛错。

## 提交要求

- 先读根目录 `AGENTS.md`（尤其第 2、3 节）。
- 从最新 `main` 开分支 `task/M1-24-adherence-core`，一个 PR，不合并。
- 在 `app/` 里跑通 `npm run typecheck && npm test && npm run build`。
- PR 描述写四件事：做了什么、怎么验证的、有什么风险、没做什么；另外单列“我做的假设”。
- 不新增依赖。

## 完成记录

- 合并请求：
- 结果：
