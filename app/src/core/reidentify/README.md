# 换手机认回（V2-07）

第二版不抄助记词、不刷脸：清空浏览器后靠“认识你的人”认回身份。学生由老师认，老师由学生认；认回后对方把保留期内的记录自动发回（复用 V2-05 的 `records.backup`）。

## 两条线

- **学生换手机**：老师（身份没变）生成“学生换手机”找回链接；学生在清空后的新身份上打开，填老师平时对他的称呼，发出 `reidentify.request`。老师在“今天”页看到“小王说他换了手机，是他吗？”，默认按称呼唯一匹配预选旧学生，重名/没有匹配时列出候选。老师点“是”：写入 `identity-links` 的旧学生公钥 → 新学生公钥，把 `teacher-students` 里的旧公钥换成新公钥，发 `reidentify.confirm`，再把保留期内的记录逐条回发。学生按“老师确认过的换机关系”验旧公钥名下的病历签名。
- **老师换手机**：老师清空后在新身份上生成“老师换手机”找回链接（带老师称呼），由老师本人手动发给每位学生。学生打开后看到“阿慈老师说她换了手机，是她吗？”，点“是”才把“我的老师”白名单里的旧公钥换成新公钥、写 `identity-links` 的旧老师公钥 → 新老师公钥，发 `reidentify.confirm`，并把手里的病历回发给新老师。**学生没点“是”之前，新老师公钥签的任何东西（方案、病历）都不接受。**
  - 学生选择旧老师时：只有一位老师可默认选中；两位及以上必须手动选，“是”在未选前不可点。下拉显示本机记的老师称呼（`settings/teacher-labels`），没有就显示“老师 + 公钥后 6 位”；链接里的称呼与本机某位老师称呼一致时才预选那一位，选中的人始终显示出来。
  - 老师端只在自己刚换手机时接受 `purpose:'teacher'` 的确认：生成“老师换手机”链接时写 `settings/teacher-reidentify-open`（带生成时间），只有 30 天内才认；同一发件人第二次带不同旧公钥一律不认（`reidentify-teacher-confirms` 按发件人记第一次的旧公钥），否则丢弃、不改名单、不写映射、不发记录。
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
- `settings/teacher-labels`：学生本机给老师记的称呼/馆名（键为老师公钥），换机提示与“我的老师”列表优先显示它。
- `settings/teacher-reidentify-open`：老师生成“老师换手机”链接的时间（30 天内才接受 teacher 类确认）。
- `reidentify-teacher-confirms`：老师端按发件人记下的已接受旧老师公钥，防止同一人反复改映射。

## 钱账连续性

## 钱账接得上（V2-07b）

- 老师确认本人/家人换机后，把旧公钥名下**已签名**的钱账事件原样携带到新身份（`ledger.carry`，老师 → 新身份）；不搬走、不改签、不加“补差”，老师端保留原件。钱账是长期数据，携带不按保留期限裁剪。
- 新身份收到 `ledger.carry` 时按 `identity-links` 校验“旧公钥 → 我”，验整条链后只读保存（`ledger-carried`）；按事件 id 幂等，重复 carry 不产生重复记录。
- 学生端/老师端读取时把旧账与新账按映射归并显示（`createLedgerSync.mergedViews`），余额与换机前一致；老师再记一笔写进新公钥那本账（没有就先 open），显示接着旧余额累加；老师端每个学生只出现一条合并后的余额与流水。
- 只发给映射到的新身份，不群发；家人那本账走同一套。

## 名单与验签按映射走

- 学生端：“我的老师”白名单换成新公钥；`historyTeachers`（`inbox` 内部）把“学生确认过的旧老师公钥”也算作这位新老师，用来收旧公钥签的历史病历；`studentKeys` 把“老师确认过的旧学生公钥”加进来验证旧学生名下的病历；展示、自动回发、调养方案过滤都按这个映射。
- 老师端：`teacher-students` 换成新公钥；`teacherContactStudents`/`teacherStudents` 用映射兜底，不重复出现同一个人；`recordsForBackup` 按“新学生 + 旧学生”一起查保留期内记录；`backupForTeacher` 接受学生确认过的旧老师公钥签的回包。
- 旧→新映射只在本机；不依赖服务端，不加 gateway/relay 接口。

## 家人随管理人一起认回（V2-07b）

- **管理人先被老师认回**（V2-07）；之后在新手机上重新添加家人、填同样称呼。添加后管理人自动发 `reidentify.family` claim（`{families:[{alias,newKey}]}`），也可点“找回家人记录”重试。
- **老师只在“发送者已被确认为某个旧管理人的新身份”时处理**（`identity-links` 的 student 映射）；只在该旧管理人的旧家人集合内按称呼唯一匹配——旧家人集合来自 `consult-package.manager === 旧管理人` 的行（当时按 M1-22 的 kind 2732 代管证明验过），称呼取 `encounter.profile.alias`。匹配上就自动写映射、发 `reidentify.confirm`、回发保留期内记录并携带旧钱账，**不让老师逐个点“是”**；别的管理人同称呼家人永远不参与匹配（验收 3）。
- 老师回 `reidentify.family` result：`matched` 或 `unresolved`（候选只列该旧管理人名下的旧家人）。管理人界面显示“这位家人没找到原来的记录”，可手动选一位旧家人对上（下次 claim 带 `oldKey`，老师校验属于该旧管理人的家人集合）；不选就当新家人。
- 家人端仍不单独确认：确认由管理人的那一次“是”覆盖；家人的 `identity-links` 存在各自分片里，收件箱/账本控制器也按分片各起一份。
- 本卡的范围不含 V2-09/V2-10；所有匹配仅在本机按公钥对应关系完成，不依赖服务端。
- 旧家人公钥只能映射一次；已对上别人时不改映射。

## 验证

`app/src/core/reidentify/reidentify.test.ts` 对应 V2-07 卡里验收 1–3：学生清空后凭老师确认收回保留期内病历（超期的不回发、旧病历按映射仍能验签）；老师清空后两位学生点头收回两人记录、第三位没点的新公钥方案被拒；冒充者自称“小王”被点“不是”后名单/映射/记录不变、不发任何回包。

`app/src/core/reidentify/family-ledger.test.ts` 对应 V2-07b 卡里验收 0–3：本人换机后钱账携带、两端归并余额相同、再记一笔接着累加；管理人与两位同称呼家人一起认回（记录+钱账余额不变、老师不用逐个点）；一位家人改称呼后管理人看到“没找到原来的记录”并手动对上；别的管理人添加同称呼家人拿不到记录。全部合成身份、合成病历、合成账本、内存投递与 fake-indexeddb。
