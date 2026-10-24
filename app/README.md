# 手机网页应用

React + TypeScript 客户端。V2 起身份在本机自动生成并直接存放（普通 IndexedDB 键值存储）：
不再有本地加密、助记词、恢复页和刷脸解锁；数据保留期限与师生互为备份见 V2-05。

在本目录运行 npm ci，然后运行 npm run typecheck、npm test、npm run build。
日常开发运行 npm run dev。src/core/identity/ 和 src/core/store/ 包含身份、存储及验收测试；
src/core/llm/ 包含模型客户端（社区网关、自有 API Key、本地模型）及其测试。
src/core/ledger/ 包含康币账本核心（单一写入者记账链、异议列表、余额/欠费）及其验收测试。
身份完成后“今日作业”进入学生打卡页；本地加密保存，不发网络。详见 src/core/homework/README.md。
M1-08：网页提醒见 app/src/core/push/README.md；gateway/push 为唯一有状态组件。
src/IntakePage.tsx 是学生采集页（说话、追问、照片、确认发送）；核心逻辑见 src/core/intake/README.md。
src/SignEncounterPage.tsx 是老师端审改、签字界面；docs/screenshots/sign-encounter-375.png 为 375px 截图。
src/InPersonPage.tsx 是老师端面诊记录界面（老师代录 intake、当面拍照，签字交还复用 M1-10/M1-11）；docs/screenshots/in-person-375.png 为 375px 截图。

M1-14b：设置中登记师生公钥、查看康币账本和对账码；打开/前台恢复/推送后同步。规则与已知边界见 src/core/ledger/README.md。双方需各自登记账本。本卡没有记账操作页和真实支付。

M1-15a：首页按“学生 / 老师”角色（设置里手动选）显示入口。src/StudentRecordsPage.tsx 是学生病历页（只显示有效签名，旧版折叠）；src/TeacherInboxPage.tsx 是老师问诊箱（照片到齐才能起草、签字交还、可选扣费）；src/core/inbox/ 负责收件分发与照片校验，src/core/wiring/ 把一条 transport、收件分发与账本同步接起来。学生端只接收“我的老师”白名单里的老师签发的病历（设置里可手动登记，发问诊包后自动加入）。发送成功后提醒收件人：部署时配置 `VITE_PUSH_GATEWAY_URL`、`VITE_PUSH_VAPID_PUBLIC_KEY` 即调用 M1-08 的 `notifyRecipient`（未配置则不提醒、不影响发送）。截图 docs/screenshots/student-records-375.png、docs/screenshots/teacher-inbox-375.png。

M1-15b：部署可选 `VITE_MODEL_GATEWAY_URL`（完整社区网关基址，结尾 `/v1`），老师问诊箱复用现有 NIP-98 客户端；未配置仍走既有无模型回退。收件后页面自动刷新，恢复/改中继后重建共享 wiring，账本页不额外启动控制器。老师“设置 → 导出试点指标”下载本机 CSV，签字交还后可评分或跳过。公式与本机保存边界见 src/core/pilot/README.md；真实中继/网关/浏览器验收见仓库 e2e/README.md。

M1-17：首次自动建立本机身份，只选老师/学生；邀请学生、邀请兑换和账本登记不要求输入后台编号。后台签名不变。边界和验证见 src/core/onboarding/README.md。

M1-17：提醒入口移入“设置”，优先自动使用部署的VITE_PUSH_GATEWAY_URL与VITE_PUSH_VAPID_PUBLIC_KEY；兼容手工配置放在默认收起的高级区。提醒仍由本人点按钮授权，未改订阅/推送鉴权或消息文案。

M1-20：TeacherWorkspace 提供今天/面诊/远程/管理四页。今天与远程共用本地急症排序；远程点开直接起草整张卡片，“说说怎么改”走 drafting/revise，改后仍为 ai_draft。SignEncounterPage 只在真人点击“签字发出”时用 record/sign.acceptDraftForSigning 统一改为 teacher、note: ai_accepted，随后执行原签字交还；签字模块不引用模型。原始 AI 草稿仍用于修改率对照。管理页可保存本机问诊模板，下一次起草读取。面诊从已有索引/收到的问诊选择学生，用一个输入框和键盘话筒逐句代录与拍照，经共享 transport 发出签名病历。

TeacherWorkspace 保留 mirror 和 renderCarePlan 组件扩展点，默认已接入 M1-18。375px 截图：docs/screenshots/teacher-{today,in-person,remote,manage}-375.png。

M1-18 已合并后的接入：DailyMirrorCard 直接复用 currentCarePlan/getDailyMirror/currentJieqi/getWeather 与现有打卡、自评集合，展示当日建议、天气及打卡摘要；未知城市不取天气、请求失败不阻断。老师今天页可给自己定制，远程当前问诊卡片和已知学生入口可用 TeacherCarePlan 的单输入框起草、人工确认签发。学生已有首页暂复用同一只读镜子展示，以完成端到端次日验收；M1-19 的三页导航仍由其原任务施工。默认选现有老师名单第一位，与当前问诊默认一致。同日缓存不主动失效，新签方案次日起引用。

M1-20 面诊照片补齐：RecordPhotos 在学生病历中显示本机图片，不使用外部 URL。老师先发出签名病历及逐张照片，学生验签、核对哈希后保存；V2 起老师原件不在此处销毁，保留期限交给 V2-05 统一处理。信封和存储格式见 core/inbox/README.md。

V2-22：HallGroundwork 在登记馆名之后接六项基础工作，老师首页和我的馆也能补齐；TemplateStudio 是唯一四类模板编辑入口，原 TemplateSettings 仅挂载它。默认值可逐项确认，状态只存本机，重开续做；新馆缺项禁邀请，旧馆提示补齐。排班与邀约只是配置，药材库入口明确待接入，不冒充实际预约或库存。
