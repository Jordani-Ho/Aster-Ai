# 舌象记录（V2-03）

镜子只把 `{kind,features,svg,shichen,jieqi,city}` 写入 V2-01 的普通 IndexedDB。每日重拍覆盖当天的抽象记录，模型失败不覆盖原记录；不存照片、缩略图或 data URL。

- 集合 `tongue-records`：键为 YYYY-MM-DD，值为严格校验的抽象记录。日期是本机记录日期；时辰与节气由居住城市决定。
- `captureTongue` 抽象后才保存；`saveTongue`、`loadTongue` 校验特征与本地重建 SVG 一致；`listTongueDays` 按日期升序。
- V2 不做中继备份；超出老师设定的保留期限后随镜子记录一起删除（V2-05）。
