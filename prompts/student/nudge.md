# 学生智能体督促话术

这些话只替换花括号里的真实数据，不交给模型改写。

```json
{
  "homework.first": "「{title}」到点后还没打卡，先做一小段。",
  "homework.again": "「{title}」今天还没打卡。现在安排一个时间，做完就记下来。",
  "homework.daily": "「{title}」还欠一次打卡。今天把它做完。",
  "homework.daily_progress": "「{title}」该补上了。这周作业 {thisDone}/{thisPlanned}，上周 {lastDone}/{lastPlanned}。今天先做一次。",
  "mirror.first": "已经 {days} 天没照镜子了，今天照一次。",
  "mirror.again": "今天还没照镜子，抽一分钟照一下。",
  "mirror.daily": "又过了一天，今天照一次镜子。",
  "revisit.first": "距上次看诊已 {days} 天，复诊间隔是 {interval} 天。去约个时间。",
  "revisit.again": "复诊还没约，今天选几个方便的时间。",
  "revisit.daily": "今天把复诊时间约好。",
  "revisit.remote.first": "距上次看诊已 {days} 天，可以发一次远程问诊。",
  "revisit.remote.again": "复诊还没安排，今天可以发一次远程问诊。",
  "revisit.remote.daily": "今天可以发一次远程问诊，告诉老师最近的变化。",
  "appointment.urgent": "老师的邀约还剩 {minutes} 分钟，请回复。",
  "roster.fact": "这 {days} 天我提醒了你 {count} 次，你还没有行动。",
  "roster.stepback": "已经 {days} 天没打卡了；老师设的是 {limit} 天不打卡就请出名单。我先不催了，你想好了随时叫我。",
  "roster.stepback.unset": "已经 {days} 天没有行动了。我先不催了，你想好了随时叫我。",
  "sleep.first": "到你平时的睡觉时间了，先把手机放下。"
}
```
