# 换手机认回（V2-07）

第二版不抄助记词、不刷脸：清空浏览器后靠“认识你的人”认回身份。学生由老师认，老师由学生认；认回后对方把保留期内的记录自动发回（复用 V2-05 的 `records.backup`）。

## 两条线

- **学生换手机**：老师（身份没变）生成“学生换手机”找回链接；学生在清空后的新身份上打开，填老师平时对他的称呼，发出 `reidentify.request`。老师在“今天”页看到“小王说他换了手机，是他吗？”，默认按称呼唯一匹配预选旧学生，重名/没有匹配时列出候选。老师点“是”：写入 `identity-links` 的旧学生公钥 → 新学生公钥，把 `teacher-students` 里的旧公钥换成新公钥，发 `reidentify.confirm`，再把保留期内的记录逐条回发。学生按“老师确认过的换机关系”验旧公钥名下的病历签名。
- **老师换手机**：老师清空后在新身份上生成“老师换手机”找回链接（带老师称呼），由老师本人手动发给每位学生。学生打开后看到“阿慈老师说她换了手机，是她吗？”，点“是”才把“我的老师”白名单里的旧公钥换成新公钥、写 `identity-links` 的旧老师公钥 → 新老师公钥，发 `reidentify.confirm`，并把手里的病历回发给新老师。**学生没点“是”之前，新老师公钥签的任何东西（方案、病历）都不接受。**
- **不是**：老师点“不是”只发一条 `reidentify.reject` 作废通知，名单、映射、记录都不改，也不回发任何记录；学生点“不是”什么都不改、不发。

## 消息与本地状态

| 消息 | 方向 | 用途 |
| :-- | :-- | :-- |
| `reidentify.request` | 学生 → 老师 | “我是原来的某某”（payload `{alias}`） |
| `reidentify.confirm` | 老师 → 学生 / 学生 → 老师 | payload `{purpose:'student'|'teacher', oldKey, newKey}`；收件人必须是 `newKey` |
| `reidentify.reject` | 老师 → 学生 | 作废通知（`{purpose:'student'}`），不带记录 |

- 找回链接：普通邀请链接（`makeInvite`/`inviteLink`）+ URL 参数 `reidentify=student|teacher`（老师称呼可选 `name`）。普通邀请仍走既有加入流程，两者不混。
- `identity-links` 集合：键为旧公钥（64 位十六进制），值 `{kind:'student'|'teacher', oldKey, newKey, at}`。老师端、学生端都只存公钥对应关系，不存记录内容；不做数据迁移。
- `reidentify-requests`：老师端待确认请求（键为新学生公钥，值 `{student, alias, receivedAt}`）。
- `settings/reidentify-request-at`：学生最近一次发出请求的时间；`settings/reidentify-rejected`：收到作废通知的时间（只做提示）。

## 名单与验签按映射走

- 学生端：“我的老师”白名单换成新公钥；`historyTeachers`（`inbox` 内部）把“学生确认过的旧老师公钥”也算作这位新老师，用来收旧公钥签的历史病历；`studentKeys` 把“老师确认过的旧学生公钥”加进来验证旧学生名下的病历；展示、自动回发、调养方案过滤都按这个映射。
- 老师端：`teacher-students` 换成新公钥；`teacherContactStudents`/`teacherStudents` 用映射兜底，不重复出现同一个人；`recordsForBackup` 按“新学生 + 旧学生”一起查保留期内记录；`backupForTeacher` 接受学生确认过的旧老师公钥签的回包。
- 旧→新映射只在本机；不依赖服务端，不加 gateway/relay 接口。

## 家人（本卡收窄）

本卡只认回本人：管理人换手机只恢复管理人自己，家人不自动恢复。家人之后由管理人重新添加（全新身份）；旧家人记录留在老师端按保留期限处理，不做旧家人公钥 → 新公钥映射，也不加额外协议轮次。家人自动认回另开卡 `docs/tasks/v2/V2-07b-reidentify-family.md`，紧接本卡之后做。

### V2-07b 接续点（本卡不实现、不写半套逻辑）

本卡把“一个人的旧→新公钥关系”抽象成 `identity-links` 的 `kind: 'student'` / `'teacher'` 两类；家人账户在这个应用里本来就是独立的学生身份，所以 V2-07b 可以直接复用、不需要改动本卡代码：

- **老师端找旧家人**：`consult-package` 里每份代管问诊都带 `manager`（旧管理人权身份公钥）和 `encounter.profile.alias`（家人称呼）；V2-07b 可用 `manager === 旧学生公钥` 找出旧管理人名下的家人公钥与称呼，再按称呼匹配新家人身份。
- **写映射**：对新旧家人公钥调用本卡的 `saveIdentityLink(store, 'student', 旧家人公钥, 新家人公钥)`；之后 V2-07 已有的 `recordsForBackup`（按旧/新学生公钥一起查保留期记录）、`canonicalStudents`（名单归并）、`receiveRecordsBackup`（旧学生公钥验签放宽）都会自动生效，不需要再改本卡逻辑。
- **消息**：`reidentify.request` / `reidentify.confirm` 的解析只读已知字段、忽略额外字段；V2-07b 可以在同一信封里加 family 字段扩展，不改已有消息版本。
- **家人端不单独确认**：确认由管理人的那一次“是”覆盖；家人分片自己的 `identity-links` 也能用同一集合（每个家人身份有独立分片存储）。
- 本卡没有发送、保存或匹配任何家人信息；上面只是接续位置。

## 验证

`app/src/core/reidentify/reidentify.test.ts` 对应卡里验收 1–3：学生清空后凭老师确认收回保留期内病历（超期的不回发、旧病历按映射仍能验签）；老师清空后两位学生点头收回两人记录、第三位没点的新公钥方案被拒；冒充者自称“小王”被点“不是”后名单/映射/记录不变、不发任何回包。全部合成身份、合成病历、内存投递与 fake-indexeddb。
