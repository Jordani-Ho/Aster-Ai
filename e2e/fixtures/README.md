# 合成练习视频

`practice-60s.mp4` / `practice-5s.mp4` 只有 FFmpeg 的 testsrc2 色条和 440Hz / 550Hz 正弦音，
不含人像、语音、学生资料或导入的媒体。160×240、2 fps、H.264 baseline / AAC mono，2026-10-18 生成。
长片 636494 字节，短片 55838 字节。E2E 用 ISO-BMFF `free` box 将长片补到恰好 20 MiB，
不把大文件提交入库；文件依然能解码。短片用于学生回传与双播放器同步。

生成工具只在本机 D 盘缓存，不进仓库或应用：Gyan FFmpeg 9.0.2 essentials（GPLv3 构建，2026-09-19），
[构建来源](https://www.gyan.dev/ffmpeg/builds/)，查证 2026-10-18。
7z 包 SHA256：`4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077`。

复现（短片将 60 换成 5、440 换成 550）：

```sh
ffmpeg -f lavfi -i testsrc2=size=160x240:rate=2 -f lavfi -i sine=frequency=440:sample_rate=44100 \
  -t 60 -c:v libx264 -preset ultrafast -crf 32 -pix_fmt yuv420p -profile:v baseline \
  -c:a aac -b:a 32k -ac 1 -movflags +faststart -map_metadata -1 practice-60s.mp4
```

输出文件 SHA256：

- 60 秒：`9467d4e985aae9d2d22b9859612b63bc4cb2f4a5ac149f73dcd93ef41a0fcd0d`
- 5 秒：`8d13f91028f34b5dfbf93b1971f3078f2d14a2aa8705e6aa44ab1f0695c72ed5`

不依赖浏览器能编码 AAC 来生成 fixture：当前测试 Chromium 可解码 AAC，但编码配置实测不支持；
用浏览器自己造 AAC 会在进入产品流程之前失败。不能以跳过声音或改成静音视频冒充带声互播验收。
