# 构建验证脚本

`check-bazi-bundle.mjs` 读取独立八字构建的分包报告，并运行真实生产 ESM 分包验证历史标准时。

在 app/ 运行 `npm run build:bazi`。输出只写到工作目录的 `bazi-bundle/`，不改变应用界面或主入口。构建配置同时检查时区库未进入同步入口，以及时区代码/数据的 gzip（level 6）合计不超过 150,000 字节。
