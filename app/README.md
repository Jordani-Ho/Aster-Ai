# 手机网页应用

React + TypeScript 客户端。M1-01 提供首次身份生成、抄写核对和恢复界面。
M1-02 提供 IndexedDB 本地加密存储，身份由不可导出的设备密钥包裹保存，重启可解锁。
清理浏览器数据后需助记词恢复身份，并从后续 M1-06 备份恢复业务数据。
应用启动申请持久化存储，结果在“设置 → 存储状态”展示。

在本目录运行 npm ci，然后运行 npm run typecheck、npm test、npm run build。
日常开发运行 npm run dev。src/core/identity/ 和 src/core/store/ 包含身份、存储及验收测试；
src/core/llm/ 包含模型客户端（社区网关、自有 API Key、本地模型）及其测试。
src/core/redflags/ 包含急症红线引擎及其验收测试（含界面入口）。
src/core/ledger/ 包含康币账本核心（单一写入者记账链、异议列表、余额/欠费）及其验收测试。
身份完成后“今日作业”进入学生打卡页；本地加密保存，不发网络。详见 src/core/homework/README.md。
M1-08：网页提醒见 app/src/core/push/README.md；gateway/push 为唯一有状态组件。
src/IntakePage.tsx 是学生采集页（说话、追问、照片、确认发送）；核心逻辑见 src/core/intake/README.md。
src/SignEncounterPage.tsx 是老师端审改、签字界面；docs/screenshots/sign-encounter-375.png 为 375px 截图。
src/InPersonPage.tsx 是老师端面诊记录界面（老师代录 intake、当面拍照，签字交还复用 M1-10/M1-11）；docs/screenshots/in-person-375.png 为 375px 截图。

M1-06：身份就绪后的“备份状态”默认检查每日备份；部署用VITE_COMMUNITY_RELAYS提供公开中继列表，未配置会明确提示。支持含照片加密文件导出与助记词恢复后的中继恢复。详见src/core/backup/README.md及relay/backup.md。

M1-14b：设置中登记师生公钥、查看康币账本和对账码；打开/前台恢复/推送后同步。规则与已知边界见 src/core/ledger/README.md。复用备份中继设置，双方需各自登记账本。本卡没有记账操作页和真实支付。

M1-15a：首页按“学生 / 老师”角色（设置里手动选）显示入口。src/StudentRecordsPage.tsx 是学生病历页（只显示有效签名，旧版折叠）；src/TeacherInboxPage.tsx 是老师问诊箱（照片到齐才能起草、签字交还、可选扣费）；src/core/inbox/ 负责收件分发与照片校验，src/core/wiring/ 把一条 transport、收件分发与账本同步接起来。发送成功后提醒收件人：部署时配置 `VITE_PUSH_GATEWAY_URL`、`VITE_PUSH_VAPID_PUBLIC_KEY` 即调用 M1-08 的 `notifyRecipient`（未配置则不提醒、不影响发送）。截图 docs/screenshots/student-records-375.png、docs/screenshots/teacher-inbox-375.png。
