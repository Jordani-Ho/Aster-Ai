# 八字与周岁（M1-03）

本地纯换算核心配合按需加载入口，无学生数据上传、存储、日志或 AI 调用。遵循任务卡及 PR #4 三次答复。首次换算只加载固定静态代码和时区数据；界面、离线资源缓存和消息发送在其他任务中接入。

已使用批准的单一时区数据源修复两条历史回归，移除全部预期失败标记，等待技术合伙人审核，未合并。

```ts
import { toBazi, ageAt, cities } from './domain/tcm/bazi'

const city = cities.find(c => c.nameEn === 'Beijing')!
const result = await toBazi({ date: '2024-02-04', time: null, city })
// year/month 为 null；ambiguous.before/after 分别给出交节前后候选。
const resolved = await toBazi({ date: '2024-02-04', city,
  timeRange: { start: '17:00', end: '19:00' } })
// 年/月柱唯一，hour 仍为 null，flags 含“时柱缺”。
ageAt('2000-02-29', '2023-03-01') // 23
```

## 输入与返回

- `toBazi` 返回 `Promise<BaziResult>`，调用方必须 `await`。公开入口只同步加载城市与轻量日期校验；首次调用才动态导入 `conversion.ts`，其中同步纯函数 `convertToBazi` 完成计算，后续调用复用已加载的模块。`ageAt` 保持同步，也不会加载时区引擎。
- `date`：当地公历日期 `YYYY-MM-DD`，1900—2100 年；`time`：当地钟表时间 `HH:mm`，省略或 `null` 表示未知。禁止同时传入精确时间和大致时段。
- `city`：中英文名、东经为正的 `longitude`、IANA `timeZone`。可直接传入只读的 `cities` 条目。
- 缺时可传 `timeRange: {start,end}`，同一当地日期内的半开区间 `[start,end)`，末端允许 `24:00`。跨午夜区间需先明确出生日期；本参数不解析“下午”等自然语言，也不产生假定时柱。
- `occurrence: 'earlier' | 'later'` 用于重复的钟表时刻，默认较早。结果的 `repeatedTime` 提供两种选择与当前选择，`flags` 含“出生时刻重复”，供 M1-09 让学生选择。不存在的时刻抛 `BaziInputError`，`code = 'NONEXISTENT_LOCAL_TIME'`。
- `options.trueSolarTime` 默认 `false`；`options.ziHourRule` 默认 `'nextDay'`，也可取 `'sameDay'`。
- 结果只有 `year/month/day/hour`、`flags` 及必要的 `ambiguous/repeatedTime`。原始生日、经度、钟表时间和解析出的 UTC 不随结果返回。调用方只发送结果和 `ageAt` 的周岁，不发送 `Birth`。
- 缺时当天不交节时，三柱唯一；交节时，不确定柱为 `null`，`ambiguous` 返回 `pillars/term/termTime/before/after`。`termTime` 为交节的当地钟表时刻，四舍五入到分钟。老师端应展示两组候选，提示“请向学生确认出生时段”；确认后由学生端重新换算，禁止老师端手改八字。
- 缺时的日柱直接按输入当地日期取，不用子时、夏令时或真太阳时跨日修正。非法日期、时区、经度、规则和倒置区间报错，不修补输入。`ageAt` 拒绝早于出生日期的日期；闰日出生者平年 3 月 1 日满周岁。

## 换算依据与精度

整条时区路径只用 `timezonecomplete@5.15.1` 和 `tzdata@1.0.52`。模块显式 `TzDatabase.init(tzdata)`，不使用库的全局/模块自动发现机制。钟表时间的 UTC 候选由固定数据的总偏移往返核对：无候选为不存在，两候选为重复；不调用会自动修补缺口的 `offsetForZone`。年/月柱以 UTC+8 送入历法库，精确比较节气秒值，不受真太阳时开关影响。

日/时柱使用 `TimeZone.standardOffsetForUtc` 返回的历史标准偏移，正确扣除普通、半小时、多年战时与固定 20 分钟的夏令时。两条回归（澳门 1948-07-01、新加坡 1935-07-01）已成为普通通过测试，并加入完整四柱来源样例。代码不再依据展示名称或冬夏最小偏移猜标准时。

真太阳时采用 `UTC + 经度 × 4 分钟 + 均时差`。[均时差公式](https://gml.noaa.gov/grad/solcalc/calcdetails.html) 按 Meeus/NOAA 的太阳轨道公式计算，非天文台逐秒星历。输入精度为分钟，实际节气比较和太阳时修正保留秒；官方节气表四舍五入到分钟，所以来源边界样例取公布分钟前后各 2 分钟，避免把官方舍入误当实现错误。

子时已核对 `lunar-typescript@1.8.6` 安装包源码：`Lunar._computeDay` 的 Exact 在 23:00 加一天，Exact2 不加；`_computeTime` 始终使用 Exact 日干；`EightChar.getDay` 按 sect 1/2 选择、`getTime` 不随 sect 变化。回归测试锁定这一行为。

**IANA 数据来源和版本**：[IANA Time Zone Database](https://www.iana.org/time-zones)，通过 [tzdata npm 包](https://www.npmjs.com/package/tzdata/v/1.0.52) 分发；已安装 `timezone-data.json` 声明版本 **2026e**。`overrides` 强制 timezonecomplete 的依赖也使用 1.0.52，npm 依赖树只有这一份数据。八字换算路径不调用 `Intl`，所有日期字段使用显式 UTC 方法；测试把 `Intl.DateTimeFormat` 故意改为错误的 UTC 结果，首次及后续换算仍正确，并断言它未被调用。数据固定使设备一致，今后法规变化需要更新该固定数据，而不是随手机规则静默改变。

已验证 Node v24.20.0；另运行真实生产 ESM 分包（非 Vitest 转译）检查初始化和两条历史回归。尚未进行手机浏览器实机测试。

## 样例、独立核对与复现

`fixtures.json` 有 44 组四柱样例，每条含官方来源、定位说明、派生时刻的方法及独立公式来源；补充验收的缺时、时段、夏令时、真太阳时、周岁来源也在同一文件。仅使用公开日历日期与明确标注的边界扰动，不使用真实学生生日。

两来源定义以获批任务卡为准：

1. 香港天文台 [2024 官方节气 XML](https://www.hko.gov.hk/tc/gts/astronomy/data/files/24SolarTerms_2024.xml)（由[节气页面](https://www.hko.gov.hk/tc/gts/astronomy/Solar_Term.htm)实际引用，UTC+8），及 [2023](https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2023.pdf)、[2024](https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2024.pdf)、[1988](https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/1988.pdf) 公历农历对照表。2023-03-22 的闰二月初一依据对照表第 1 页。
2. `testing/reference.ts` 的独立参考实现，不导入生产模块或历法库。日柱用 [USNO 儒略日公式](https://aa.usno.navy.mil/faq/JD_formula) 与 [Y. T. Liu 的干支日锚点、月柱及五鼠遁推导](https://ytliu0.github.io/ChineseCalendar/sexagenary.html)；年/月柱依据官方交节边界独立计算，非 2024 年且远离边界的样例另用 [USNO 太阳黄经近似公式](https://aa.usno.navy.mil/faq/sun_approx)。近似黄经只核对星历抄录和远离边界的案例，不充当分钟级边界星历。

保存的 `testing/hko-2024.xml` 是官方原始数据，SHA256 为 `FAF1FCE249E06A472DC8FB17D42294FC49306F6E5ADE4D58379891DAD9B2E202`。测试校验 XML 与 fixtures 的 12 个“节”逐条一致，并将每条预期重新用独立公式计算后与库包装实现比较。未知时辰、缺口/重叠、规则、周岁、15° 及两个真实城市（西宁/北京，约 58.6 分钟经度差）的测试见 `app/src/bazi.test.ts`。

仓库根目录用 Node 24 可离线重建 fixtures：

```sh
node domain/tcm/bazi/testing/generate-fixtures.mts
cd app
npm run typecheck && npm test && npm run build
npm run build:bazi
```

实现前上述测试已运行失败（模块尚不存在），实现后再运行完整检查。无以库的输出生成预期值的步骤。

## 城市表来源和署名

© GeoNames contributors，[GeoNames](https://www.geonames.org/)，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。数据来源：[CN.zip](https://download.geonames.org/export/dump/CN.zip)、[cities15000.zip](https://download.geonames.org/export/dump/cities15000.zip)，[字段与许可证说明](https://download.geonames.org/export/dump/readme.txt)。2026-10-16 下载并筛选；保留中英文名、经度、IANA 时区，中文译名进行了整理，删除无关别名、人口等字段。322 条，40,503 字节，低于 300 KB。

中国部分使用 GeoNames 的 PPLC/PPLA/PPLA2 城市/行政驻地记录，剔除同属拉萨的曲水、林周、城关重复低层级驻地；保留省会和地级驻地，并加入主要海外城市。此表是 GeoNames 常用出生地选择表，不宣称是完整、实时的官方行政区划名录；上游可能漏收或使用旧称。新疆城市沿用来源的 IANA 时区，调用方必须展示时区供学生确认钟表时间。

原始压缩包 SHA256：

- CN.zip：`5B6DFB4E9C2D88BA0F01B41552954B6AD8AF3833CE6E42CCAC1242304E204E45`
- cities15000.zip：`3068649D544BACDDB18F7D80EBCEB20A6970C0948C9A3553C830047F72AE6618`

将两个压缩包存入本地目录，使用 PowerShell 在仓库根目录复现（只读原始包、写 cities.json，审计 TSV 写回原始包目录）：

```powershell
./domain/tcm/bazi/testing/select-cities.ps1 -sourceDir <原始压缩包目录>
```

## 依赖与范围

三项运行时依赖均经 PR #4 批准、发布满 14 天并固定确切版本，完整性摘要在 app/package-lock.json，已安装包的许可原文在 `THIRD-PARTY-NOTICES.md`：

| 包 | 固定版本 | 许可证 | npm 发布日（UTC） |
| :-- | :-- | :-- | :-- |
| lunar-typescript | 1.8.6 | MIT | 2025-11-05 |
| timezonecomplete | 5.15.1 | MIT | 2026-06-05 |
| tzdata | 1.0.52 | MIT，保留 IANA 数据来源 | 2026-10-01 |

上游最近维护活动已核对为 lunar 的 2026-08-13 图表修复、timezonecomplete 的 2026-06-05 版本发布及 tzdata 的 2026-10-01 数据发布；不据此承诺维护 SLA 或算法无缺陷。

`npm run build:bazi` 是独立库构建与体积检查，不给产品加界面。报告记录时区代码与完整数据的 gzip（level 6）体积，并在超过 150,000 字节或进入同步入口时使构建失败。当前时区部分 **60,093 字节 gzip**，无需裁剪数据；农历库另为 104,565 字节，转换代码为 1,992 字节，首次换算这三部分共约 167 KB。`index.ts` 到引擎只有动态导入，`ageAt`/城市读取不加载这些分包。输出同时包含第三方许可声明，分包报告见本次 PR 和 `bundle-report.json`。

不含界面、老师模板设置界面、传输/存储接线、大运、流年或其他推算。只向 M1-09 提供数据接口，不修改其他任务的业务实现。
