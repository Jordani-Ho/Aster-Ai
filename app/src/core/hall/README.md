# core/hall · 建馆

V2-15：老师第一次进来一步一步开馆。这个目录只放本机状态与第一位邀请的纯逻辑：

- `settings/hall`：`{openedAt, completedAt}`。开馆是本机状态 + 门面签发，不新增服务器接口。
- `settings/opening-guide`：`{step, firstInvite}`。引导走到哪一步、第一张邀请链接与到期时间；关掉应用再打开从同一屏继续。
- `hasOpenedHall`：老部署升级判定——已有门面、学生、病历或收到过问诊，直接视为已开馆，不重走引导。
- `createFirstInvite`：第一位学生的邀请沿用现有签名邀请格式，1 小时只是 `makeInvite` 的有效期参数；链接里仍带老师本人签名的门面。

界面在 `app/src/OpeningGuide.tsx`；管理页分块在 `app/src/TeacherManagement.tsx`。
