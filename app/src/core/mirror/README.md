# 镜子页核心（M1-18）

学生「镜子」页的数据与当日建议。

- `dailyMirror({carePlan, jieqi, weather, recentCheckins, recentSymptoms})` 返回 `{greeting, today, trend}`：有网时经 `core/llm` 网关 + `prompts/student/daily-mirror.md` 生成（≤5 条，只谈起居/饮食/情志，不下诊断、不开药）；断网或模型失败时用「调养方案 + 节气养生」拼固定建议。
- `getDailyMirror(store, input)` 加了本机缓存：同一天只生成一次，集合 `mirror`（键为 YYYY-MM-DD）。
- `trend.ts`：自评 1～5 分（集合 `self-ratings`，同日覆盖）与 M1-13 打卡一起，输出最近 14 天序列供界面画走势。

提示词在 `prompts/student/daily-mirror.md`；节气数据在 `domain/tcm/seasonal.json`，中医逻辑不写进本模块。
