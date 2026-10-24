# e2e/fixtures/tongue · V2-20 合成舌象图

只用于 `e2e/tongue.browser.mjs` 的浏览器验收，全部是 Pillow 画出来的合成形状（肤色底、嘴、两色舌头、蓝点标记），不含真人照片或真实病例。HEIC 只用来说明浏览器解不开该格式时的行为，也不是真人照片。

| 文件 | 用途 |
| :-- | :-- |
| `tongue-normal.jpg` | 1200×1600，舌头框占画面约 10%；镜子显示、MIME 容错、回复容错、重试分档都用它 |
| `tongue-long-6000.jpg` | 6000×4500，验证送模型前长边缩到 ≤1600 |
| `tongue-1pct-short160.jpg` | 1600×1600，舌头占画面 1%（160×160），裁剪短边 160 → 应通过 |
| `tongue-1pct-short100.jpg` | 1600×1600，舌头占画面 1%（100×256），裁剪短边 100 → 应提示靠近 |
| `tongue-synthetic.heic` | 1200×1600 合成 HEIC，验证两个内核都解不开时给“照片格式打不开”且不请求模型 |
| `metadata.json` | 每张图的尺寸、框与字节数，供脚本读取 |

生成脚本只在排查/施工时用过（Pillow + pillow-heif 不在仓库依赖里）；文件本身随仓库提交，测试只读。用途与失败分档见 `e2e/README.md` 的 V2-20 段和任务卡 `docs/tasks/v2/V2-20-tongue-fix.md`。
