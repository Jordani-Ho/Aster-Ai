# 天时（V2-02）

每条记录都带的“天”：时辰、节气、城市。只做时间与日期换算，不做健康判断。

- 时辰按**当地真太阳时**：经度 × 4 分钟的经度差 + 均时差（复用 `domain/tcm/bazi/solar-time` 的 Meeus 均时差），再按两小时一段定时辰（子时跨零点）。
- 城市未知时退回**设备时区的钟点时辰**，界面上提示补城市（`CITY_UNKNOWN_HINT`）。
- 节气按**天文时刻**：`lunar-typescript` 给出的北京时间换算成 UTC 后，再按学生所在地时区取当地日期（如 2026 冬至 UTC 12-21 20:50 → 北京 12-22、洛杉矶 12-21）。
- 城市经度/时区直接复用 `domain/tcm/bazi/cities.json`，不另造一套城市表；档案里的城市仍存 `profile.city`。

## 接口

```ts
heavenAt(at, city, { timeZone })   // { shichen, jieqi, city, localDate, clock, solarClock, solar }
jieqiAt(at, timeZone)              // { name, at, localDate }
formatHeavenTime({ shichen, clock }, 'both')  // '辰时 · 8:20'
heavenNow(store)                   // 按档案里的城市算此刻的天时（家人分片用自己的城市）
heavenStampOf(time)                // { shichen, jieqi, city }，写记录时带上
isHeavenStamp(value)               // 严格校验记录/问诊包里的 heaven
formatHeavenStamp(stamp, display)  // 只有时辰/节气/城市时怎么显示（钟点用该时辰的区间）
heavenLine(stamp, display)         // 老师起草页那一行，如 '学生那边：戌时 · 寒露 · 洛杉矶'；没有 heaven 返回 null
```

`clock` / `solarClock` 都是 `H:mm`（不补前导零，与界面“8:20”一致）。

## 表层配置（不写死在界面里）

| 集合/键 | 值 | 默认 |
| :-- | :-- | :-- |
| `settings/time-display` | `'shichen'` / `'clock'` / `'both'`：显示时辰、钟点或两者 | `both` |
| `settings/mirror-shichen` | 照镜子的固定时辰，如 `'辰'` | `'辰'` |

- 到了选定时辰且今天还没照镜子时，镜子页提示“辰时到了，照照镜子吧”（只提醒，不拦截）。
- 镜子页走势只拿**同一时辰**的镜子记录对照；其他时辰的记录不参与，并在走势下方提示“有 N 条记录时辰不同，不参与对照”。

## 问诊包与病历上的天时（V2-06）

- 学生点“确认发送”时取一次 heaven 放进 `ConsultPackage` 与 `Encounter`；老师签字时原样沿用，不重新取（面诊在老师开始面诊时取一次）。
- 老师起草页顶部按老师自己的 `timeDisplay` 显示一行（`heavenLine`）：`shichen` → `戌时`，`clock` → `19:00–21:00`，`both` → `戌时（19:00–21:00）`，后面接节气与城市。没有 heaven 的旧病历不显示这一行，照常验签打开。
- 家人：城市在家人设置里单独设（存家人分片的 `profile.city`），记录按家人的城市算时辰；时间显示方式与照镜子时辰沿用管理人自己的设置（`StudentShell` 用根存储传 `settingsStore`）。

## 边界

- 只做换算与配置；`heaven` 是可选字段，不参与签字硬规则。
- 作业排程里的“时辰/节气”仍是本机钟点语义，不在本卡范围。
- 依赖：`lunar-typescript`（既有）、`domain/tcm/bazi` 的均时差与城市表（既有），无新增依赖。
