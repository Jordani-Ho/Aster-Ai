# M1-23b 验收与实测记录

查证日期：2026-10-18。施工分支 `task/M1-23b-practice-video`，从 main 开始，M1-23a 合入后已 rebase。
仅实现任务卡第 1/2/2b/2c/3/4 条；习惯作业、坚持率与康币不另写规则。未修改封存分支。

## Blossom 评估

采用任务卡允许的最小服务，评估记录在 [gateway/media/README.md](../gateway/media/README.md)。
现有实现的固定源码：`hzrd149/blossom-server@7701f43011c1474dffbf5db3d69b40f488bf662c`，
6.4.0，MIT，提交日期 2026-09-30（满 14 天）。

- [GET/HEAD 与访问时间](https://github.com/hzrd149/blossom-server/blob/7701f43011c1474dffbf5db3d69b40f488bf662c/src/routes/blobs.ts)：读取 touchBlob，原生保留策略会延长到期时间。
- [日志接线](https://github.com/hzrd149/blossom-server/blob/7701f43011c1474dffbf5db3d69b40f488bf662c/src/server.ts)：默认 requestLogger 无关闭接线。
- [BUD-11 鉴权](https://github.com/hzrd149/blossom/blob/master/buds/11.md)：24242，t/x/server/expiration，base64url。

最终复用已有 Node / nostr-tools，独立媒体进程只做签名成员鉴权、流式 SHA256 上传、按哈希下载、
60 MiB + 16B 限额和上传后 30 天清理。无列表、共享库、转发、服务端转码或上游数据库补丁。

## 新依赖

| 依赖 | 固定版本 | 许可证 | 发布时间（UTC） |
| --- | --- | --- | --- |
| mediabunny | 1.61.1 | MPL-2.0 | 2026-10-03 20:08:19.858 |
| @types/dom-webcodecs（间接，lockfile） | 0.1.13 | MIT | 2024-10-08 09:36:59.492 |
| @types/dom-mediacapture-transform（间接，lockfile） | 0.1.12 | MIT | 2026-07-08 22:20:29.192 |

来源：[npm 元数据](https://registry.npmjs.org/mediabunny)、[Mediabunny 源码与许可证](https://github.com/Vanilagy/mediabunny)、
[转换文档](https://mediabunny.dev/guide/media-conversion)。不修改第三方源码，浏览器仅按需加载转换库。
FFmpeg 只用于离线生成合成 fixture，不作为应用、CI 或部署的新依赖；来源和命令见 [fixtures/README](../e2e/fixtures/README.md)。

## 已跑通的视频验收

- 真实 60 秒 H.264/AAC MP4，以合法 free box 补至 20 MiB；经系统相机 input 入口选入、加密上传、老师签字、学生播放。
- 服务实际文件长度为 20 MiB + 16B，字节与 MP4 不同；引用随原有 NIP-17 消息，不传视频分片。
- 下载网络中断显示“视频还在路上”；磁盘密文单字节篡改也拒收且本机不留文件；修复后按重试完整下载播放。
- 老师交还后，当前应用中的视频、关联索引、视频草稿、暂存清单、待发签名删除，去标识医案无视频信息。
- 学生录回 5 秒带声片，自己可并排看；老师同时播放原片/练习、收到文字回复后删除临时回看与本机两片。
- 0.5 倍播放不静音，循环及全屏控件存在。当前 Chromium 不支持测试用 AAC 编码配置，回退原片，未删除旁白轨道。
- 独立本地加密与文件备份测试使用 20 MiB：默认中继快照无二进制，完整文件可恢复家人分片视频；文件格式未改。
- 家人 HTTP 文件鉴权使用已登记代管人；业务信封、收件与本地分片继续使用家人自己的身份。

自动化是 Playwright 桌面 Chromium、375px 视口，不是真手机相机或扬声器实听。

## 真机矩阵（验收 2b）

尚未操作真实手机。下表必须由实际录制与互播结果填写，不能由能力检测或桌面模拟替代。

| 录制端 → 播放端 | iPhone Safari | 华为浏览器 | 安卓 Chrome | 微信内置浏览器 |
| --- | --- | --- | --- | --- |
| iPhone Safari | 待实测 | 待实测 | 待实测 | 待实测 |
| 华为浏览器（可用 Mate 40 Pro） | 待实测 | 待实测 | 待实测 | 待实测 |
| 安卓 Chrome | 待实测 | 待实测 | 待实测 | 待实测 |
| 微信内置浏览器 | 待实测 | 待实测 | 待实测 | 待实测 |

每项需记录机型/OS/浏览器版本、系统相机输出格式、时长/大小、是否真正转换、正常/慢放声音、
循环/全屏和并排同步结果。资料须使用合成画面或非个人信息测试内容，不上传真实学生视频作为验收附件。

## 待裁决与风险

- 网页能清理应用内存储，无法删除系统相册或老师自行导出的文件。已按 AGENTS.md §3a 向发起人提问，未擅自扩大“诊毕即还”的边界。
- 媒体服务只保留 30 天。已在学生本机的视频不受期限影响；到期且没有本机/文件备份时，需要老师重新提供或重录，不承诺老师持有旧片。
- 不支持本地转换时原片可能有拍摄元数据、HEVC/MOV 等跨设备兼容差异，必须做上述真机互播；不承诺所有系统相机输出都是 H.264。
- 整段 AES-GCM 和备份仍使用内存，大文件受手机可用内存/存储配额影响。文件恢复入口支持到 512 MiB，超过时提示换容量充足的设备。
- 尚未在家庭节点重建/启动新容器，未实测 Cloudflare 外网。compose 静态配置通过不等于真实部署验收。
