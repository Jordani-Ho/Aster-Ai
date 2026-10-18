# 作业与打卡（M1-13）

直接引用共用Homework类型。schedule(homework, startsOn, days, windowStart=startsOn)返回按时间排序的本地Date提醒。
startsOn是作业生效日；windowStart是本次查询起点，不会重置durationDays。持续3天包含生效日及后2天。
daily按HH:MM、shichen按领域表的开始时刻、jieqi按领域历法的节气日08:00、once按指定日期与时刻（省略为08:00）。
省略durationDays则在查询窗口内持续，直到后续复诊更新；查询窗口上限3660天用于避免误输入。日期采用本地日历逐日递增，避免夏令时造成日漂移；不存在的本地时间按JS Date规则向后调整，重复时刻取较早一次。子时提醒归23:00所在的公历日。

checkIn(store,id,note?,at?,heaven?)只向本机 checkins 集合写{homeworkId,at,note?,shichen?,jieqi?,city?}，键 crypto.randomUUID；V2 起本机存储不加密。传了 heaven（天时，见 `core/heaven`）就一并记下当时的时辰、节气、城市；不传不写空字段。不发fetch、WebSocket或其他网络。
sevenDayProgress按截至今天近7个本地日期内实际安排的天数计算分母，同一天重复打卡只算一次，尚未生效和已过期日不计入。未安排当天的历史记录不算完成。

今日作业页从本机 homework 集合读取{homework,startsOn}，提供备注/打卡/7天状态格；无数据时可由用户主动载入合成示例，并明确标注示例。真实签字病历中的作业由收件逻辑写入这个集合。
页面每15秒与恢复前台时刷新到点提示；已授权通知时尝试固定系统通知（不含作业内容），不支持则保留页内提示。同一次页面挂载每项作业每日只通知一次。

**关闭应用后不定时提醒**；后台计时器可能被浏览器挂起，重新打开会重新计算当天到期项。本卡不接推送、不把打卡发给老师、不做健康判断。

验收：homework.test.ts覆盖时辰边界、数据出处、四类排程、有效期、节气、本机存储与无网络、完成比例、跨年闰日及夏令时。
docs/screenshots/homework-375.png 为375px宽实际页面截图；无头Edge验证打卡后刷新仍保持完成状态。全部为合成身份和示例作业。
