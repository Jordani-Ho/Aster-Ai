# 舌象日记（M1-18）

每天最多拍一张舌象，复用 `intake/photo.ts` 压缩去 EXIF（长边 ≤1600、JPEG、无元数据、≤500 KB），加密存本机。M1 只存与列，不做自动分析。

- 集合 `tongue-photos`：键为 YYYY-MM-DD，值为处理后的 JPEG 字节（bin 记录）。同一天再拍会覆盖当天早前那张。
- `listTongueDays` 按日期升序列出；`recentTongue(days=30)` 返回最近 30 天的字节，界面直接小图渲染作缩略列表（M1 不另存缩略图）。
- 字节随完整备份恢复，中继备份显式排除。
