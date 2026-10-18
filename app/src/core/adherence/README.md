# 坚持率计算（M1-24，纯逻辑）

给定一位学生的作业与打卡记录，算出“连续练了几天”“最近 7 天坚持率”“是否该提醒”。本模块**只写纯函数**：不读写存储、不改界面、不改病历格式、不新增依赖；排程与打卡类型直接复用 `app/src/core/homework/`（`schedule`、`Checkin`、`Assignment`），不重写排程。

## 接口

```ts
export interface AdherenceDay { day: string /* YYYY-MM-DD，设备本地日期 */; scheduled: number; done: number }
export function dailyAdherence(assignments: Assignment[], checkins: Checkin[], from: string, to: string): AdherenceDay[]
export function currentStreak(assignments: Assignment[], checkins: Checkin[], today: string): number
export function weeklyRate(assignments: Assignment[], checkins: Checkin[], today: string): number | null
export function needsNudge(assignments: Assignment[], checkins: Checkin[], today: string): boolean
```

## 规则

1. **某天有作业** = 这一天按 M1-13 的 `schedule()` 至少有一条作业（生效日期、`durationDays`、时辰、节气、单次都由 `schedule()` 处理，这里不重复实现）。
2. **某天完成** = 当天有该作业的打卡；同一天多次打卡只算一次。
3. **`currentStreak`**：从 `today` 往回数，**有作业且全部完成**的天连续计数；**没有作业的天跳过**，不算中断也不加一；`today` 当天还没完成不算中断（从昨天开始数；如果今天已完成则计数）。
4. **`weeklyRate`**：含 `today` 在内最近 7 天，完成条数 ÷ 应有条数；这 7 天一条作业都没有时返回 `null`。
5. **`needsNudge`**：最近两个“有作业的日子”（**不含今天**）都没有全部完成时返回 `true`。只有一天有作业、或其中一个已完成时返回 `false`。
6. **日期一律按设备本地日期**（与 M1-13 的 `localDay()` 一致）；日期枚举用本地日期构造（`new Date(y, m, d)` / `addDays`），不用毫秒加减，因此夏令时切换周不会多算或少算一天。

## 我做的假设（需要技术合伙人确认）

- **范围上限 3660 天**：`schedule()` 的窗口上限就是 3660 天，`dailyAdherence` 和内部回溯也沿用；超过直接抛“日期范围过大”，不给出可能错误的结果。
- **容错**：格式不对的打卡（`at` 不是合法时间）忽略，不抛错（验收第 10 条）；作业排程本身坏掉的条目（缺字段、非法排程）在计算时静默跳过，不让一条坏数据把整页算错。传入的 `from`/`to`/`today` 必须是合法 `YYYY-MM-DD`，否则抛错。
- **habit（M1-23a 随习惯作业）暂未计入**：本卡在 main（只有 daily/shichen/jieqi/once）上实现；`schedule()` 对 habit 不产生钟点提醒，所以 habit 作业目前不会出现在“有作业”的天里。M1-23a 的第 5 条（坚持率界面）合并时，需要在同一分支里决定 habit 是否/如何计入（例如按“每天有习惯作业”算一条），本模块预留纯函数接口，不自己写第二套排程。
- **只统计“当天有排程的作业”**：额外的打卡（没排程或已过期）不会提高完成数，也不会降低坚持率。
- **“全部完成”按条数**：同一天两条作业只完成一条，这一天在 `currentStreak` 里算中断，在 `needsNudge` 里算“没有全部完成”。

## 验证

`app/src/core/adherence/adherence.test.ts` 覆盖卡片验收 1–10：连续 5 天、中间漏打、单次/节气稀疏、今天未打卡不归零、同日多次打卡、`durationDays` 到期、`weeklyRate` 4/6 与 `null`、`needsNudge` 正反例、夏令时切换周（`TZ=America/Los_Angeles`，2026-10-31 为 PDT、11-02 为 PST）以及非法 `at` 忽略。跑 `cd app && npm run typecheck && npm test && npm run build`。
