# 坚持率计算（M1-24 + M1-23a，纯逻辑）

给定一位学生的作业与打卡记录，算出“连续练了几天”“最近 7 天坚持率”“是否该提醒”，并给老师端“今天”页排序。本模块**只写纯函数**：不读写存储、不改界面、不改病历格式、不新增依赖；排程与打卡类型直接复用 `app/src/core/homework/`（`schedule`、`Checkin`、`Assignment`），不重写排程。

## 接口

```ts
export interface AdherenceDay { day: string /* YYYY-MM-DD，设备本地日期 */; scheduled: number; done: number }
export function dailyAdherence(assignments: Assignment[], checkins: Checkin[], from: string, to: string): AdherenceDay[]
export function currentStreak(assignments: Assignment[], checkins: Checkin[], today: string): number
export function weeklyRate(assignments: Assignment[], checkins: Checkin[], today: string): number | null
export function needsNudge(assignments: Assignment[], checkins: Checkin[], today: string): boolean

// M1-23a 新增
export function weekStart(today: string): string                 // 本周周一
export function adherenceReport(assignments, checkins, today): AdherenceReport  // 学生端发给老师的本周小结
export function rankStudentAdherence(reports, today): reports[] // 老师端“今天”页排序：低坚持率先前，null 最后
```

`AdherenceReport = { weekStart, weeklyRate, streak, practiceDays, scheduled, done }`，学生端通过 `homework.adherence` 信封发给老师，只含数值、不含原文/身份字段；老师端按发件人覆盖保存最新一周，旧周小结迟到不会覆盖新周。

V2-36 追加 `hasHomework`、`homeworkSince`、`homeworkUntil`、`lastCheckinDay`，仍只传事实日期与数值。当前没有作业、已做完的单次作业和到期作业不算未打卡；旧报告缺字段时老师不能用它请出学生。老师端也按消息时刻拒收迟到的旧小结。

## 规则

1. **某天有作业** = 这一天按 M1-13 的 `schedule()` 至少有一条作业（生效日期、`durationDays`、时辰、节气、单次都由 `schedule()` 处理，这里不重复实现）。
   - **随习惯作业（M1-23a）**：`{ kind:'habit'; anchor }` 没有钟点提醒，但每个生效日算一条“有作业”，打卡计入坚持率；失效规则同 `durationDays`。
2. **某天完成** = 当天有该作业的打卡；同一天多次打卡只算一次。
   - **子时跨零点归日（M1-23a 边界）**：本地时间 **00:00:00–00:59:59** 的打卡算**前一天**（例：26 日子时练、27 日 00:10 打卡 → 26 日算完成）；01:00 起算当天。用 `core/homework/schedule.ts` 的 `checkinDay()` 统一归日，夏令时切换在凌晨 2 点，不影响零点归属；日期枚举仍用本地日期构造，不会多算/少算一天。
3. **`currentStreak`**：从 `today` 往回数，**有作业且全部完成**的天连续计数；**没有作业的天跳过**，不算中断也不加一；`today` 当天还没完成不算中断（从昨天开始数；如果今天已完成则计数）。
4. **`weeklyRate`**：含 `today` 在内最近 7 天，完成条数 ÷ 应有条数；这 7 天一条作业都没有时返回 `null`。
5. **`needsNudge`**：最近两个“有作业的日子”（**不含今天**）都没有全部完成时返回 `true`。只有一天有作业、或其中一个已完成时返回 `false`。
6. **日期一律按设备本地日期**（与 M1-13 的 `localDay()` 一致）；日期枚举用本地日期构造（`new Date(y, m, d)` / `addDays`），不用毫秒加减，因此夏令时切换周不会多算或少算一天。
7. **本周口径**：`weekStart` 从**周一**算起；`practiceDays` = 本周有完成记录的天数（“本周练习天数”）。
8. **老师端排序**：同一周的小结里，坚持率 <50% 的按升序排前面；`null`（本周没安排作业）不参与排序、排最后，也不显示 0%。

## 我做的假设（需要技术合伙人确认）

- **范围上限 3660 天**：`schedule()` 的窗口上限就是 3660 天，`dailyAdherence` 和内部回溯也沿用；超过直接抛“日期范围过大”，不给出可能错误的结果。
- **容错**：格式不对的打卡（`at` 不是合法时间）忽略，不抛错（验收第 10 条）；作业排程本身坏掉的条目（缺字段、非法排程）在计算时静默跳过，不让一条坏数据把整页算错。传入的 `from`/`to`/`today` 必须是合法 `YYYY-MM-DD`，否则抛错。
- **只统计“当天有排程的作业”**：额外的打卡（没排程或已过期）不会提高完成数，也不会降低坚持率。
- **“全部完成”按条数**：同一天两条作业只完成一条，这一天在 `currentStreak` 里算中断，在 `needsNudge` 里算“没有全部完成”。
- **子时归日是“打卡归日”而非“排程延后”**：作业仍按原日期要求；只是 00:00–00:59 的打卡记到前一天，避免“练完跨零点打卡丢一天”。
- **老师端数据来源**：老师拿不到学生本机 IndexedDB，只能看学生端主动上报的本周小结（`homework.adherence`）；它是学生端自算的数值，不含原文/身份。老师端只展示与排序，不做二次判定；上报失败不影响学生打卡。

## 验证

`adherence.test.ts` 覆盖原 M1-24 验收 1–10（连续 5 天、中间漏打、单次/节气稀疏、今天未打卡不归零、同日多次打卡、`durationDays` 到期、`weeklyRate` 4/6 与 `null`、`needsNudge` 正反例、夏令时切换周 `TZ=America/Los_Angeles`、非法 `at` 忽略），M1-23a 追加 11–14（子时归日、habit 计入、验收 4 的镜子提醒与老师端排序、本周小结口径）。
`adherence-family.test.ts` 覆盖第 6 条：家长替孩子在家人分片打卡、家人身份上报、老师端按家人身份保存并排序、本人分片数据隔离。
跑 `cd app && npm run typecheck && npm test && npm run build`。
