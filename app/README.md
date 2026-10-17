# 手机网页应用

React + TypeScript 客户端。M1-01 提供首次身份生成、抄写核对和恢复界面。
M1-02 提供 IndexedDB 本地加密存储，身份由不可导出的设备密钥包裹保存，重启可解锁。
清理浏览器数据后需助记词恢复身份，并从后续 M1-06 备份恢复业务数据。
应用启动申请持久化存储，结果在“设置 → 存储状态”展示。

在本目录运行 npm ci，然后运行 npm run typecheck、npm test、npm run build。
日常开发运行 npm run dev。src/core/identity/ 和 src/core/store/ 包含身份、存储及验收测试；
src/core/llm/ 包含模型客户端（社区网关、自有 API Key、本地模型）及其测试。
src/core/redflags/ 包含急症红线引擎及其验收测试（含界面入口）。
