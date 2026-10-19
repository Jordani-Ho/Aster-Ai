# 舌象记录（V2-08 第一级）

只留舌头裁剪图 + 模型候选特征，老师说了算。原图（含脸、鼻子）只存在于拍照那一次调用的内存里，裁剪完当场清零：不写本机集合、不发中继、不留缩略图或 data URL。

- 集合 `tongue-records`：键为 YYYY-MM-DD，值为严格校验的 `TongueAbstract` `{kind,features,svg,shichen,jieqi,city,lightingNote?,crop?}`。日期是本机记录日期；时辰与节气由居住城市决定。
- 集合 `tongue-crops`：镜子页的舌头裁剪图字节 `{id, at, data}`，键为裁剪图 id；只留最新一张，旧条目按要求提示“这次的裁剪图已被新图替换”。按老师设定的保留期限删除。
- 问诊的裁剪图走既有附件通道（`intake-attachments` / 老师端 `attachments`），仍按保留期限两端删；签字病历里的特征值不依赖图片。
- 特征：`domain/tcm/tongue-features.json` 每项都有 `uncertain`（不确定）；齿痕/裂纹是 `[]` 未见、`null` 有（位置不确定）、`'uncertain'` 不确定三种状态。`unknown` 是 V2-03 旧记录的存量取值，读入后按“不确定”显示，不再写出。
- 模型回复必须带舌头外接框 `box`（相对坐标 0–1）和 `lightingNote`；框占画面不到 5% 或找不到舌头时提示“没拍清舌头，请靠近一点重拍。”，不生成记录。
- 示意图 SVG 由本地固定模板重建（颜色类别、虚线待定区、灰底颜色未定），绝不使用模型 SVG 或照片像素；签字覆盖整个抽象结果。
- `tongueLevel` 默认第一级；本版只开放第一级，第三级（只留特征值）不开放。
