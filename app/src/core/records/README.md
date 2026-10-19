# records · 老师医案、保留期限与师生互为备份（V2-05）

四件事：老师端留完整医案（第 0 步）、保留期限（第 1 步）、长期沉淀（第 2 步）、师生互为备份（第 3 步）。全部只用本机集合与现有传递层，不新增依赖。

## teacher.ts：完整医案

- 集合 `teacher-records`：键为签名事件 id，值为 `{ eventId, encounterId, version, student, createdAt, eventJson }`。`eventJson` 是 kind 2730 的完整签名事件（content 是整份 Encounter），V2 不再要求去标识。
- 写入：远程 `completeConsultSigning` 与面诊 `signAndHandoverInPerson` 在发送成功后调用 `saveTeacherRecord`；同一事件重放只覆盖相同内容。写入前重算事件 id、验签（E-004）并核对 `teacher`/`p` 标签，学生回发的备份走同一条路。
- 读：`teacherStudents`（面诊选“已有学生”，按学生公钥去重）、`teacherCases`（起草时的医案检索，投影为 `DraftCase`，id 用签名事件 id）、`latestTeacherRecord`（改方时取上一版事件 id）。`revisedEncounter` 生成下一版：`version + 1`、`supersedes` 指向旧版事件 id，方子变了还把 `previousOf` 指向旧版。
- 康币扣费的 `recordHash` 就是这份签名事件 id，账本与医案对得上。
- 集合 `teacher-students`：老师认得的学生的公钥名单（不含病历内容）；收到问诊或签字医案时自动登记，换手机后靠它逐个向学生要回病历。

## retention.ts：保留期限

- 老师设置存在 `settings/retention-days`：默认 90 天，可选 30 天到 3 年（1095 天），非法值不入库。
- 随调养方案发给学生：`retention.setting` 信封，载荷 `{ teacher, days, updatedAt }`；学生端按老师公钥存在 `teacher-retention`。学生可能有多位老师，取最短的期限（最保守）。
- `runRetention(store, role, { now, days })`：时间可注入，不依赖真实时钟。
  - 老师端：删超过期限的 `teacher-records`、`consult-package`、`in-person-draft`，再删不再被这些记录引用的 `attachments`（V2-08 起包括病历里引用的舌头裁剪图）。
  - 学生端：删超过期限的 `self-ratings`、`self-stress`、`tongue-records`、`tongue-crops`（V2-08 镜子只留最新裁剪图，按保留期限删）、`checkins`、`intake-sent`、`intake-draft`、不再被引用的 `intake-attachments`（含问诊舌象裁剪图），以及收到的签名病历 `student-records` 与随它的面诊照片索引/字节（`record-photo-index`/`record-photos`）。
- `runRetentionOnce`：打开应用时每天只跑一次（`settings/last-retention-day` 去重），不做后台任务。
- 长期保留的沉淀：`care-plans`（最新一版）、`homework`（作业规则）、`teacher-fingerprint`（改稿习惯摘要）、`kangbi-observations`（康币观察记录，只有计数与评分、没有内容，是将来给康币定值的依据）与 `kangbi-events`，都登记在 `LONG_TERM_COLLECTIONS`，不在删除范围。
- 钱账与康币账的长期数据一律不碰：保留期只清医案、问诊包、照片与本机记录类集合。

## fingerprint.ts：老师的思想指纹

- 集合 `teacher-fingerprint`，键为老师公钥，值为 `{ records, paths: { 字段: { drafts, changed } }, tongueDiffs: { "齿痕：模型不确定→老师有": 次数 }, updatedAt }`；只留计数，不留原文、不留图、不留学生身份。签字时用 `modificationLog` 累计改稿路径，V2-08 起另把“模型候选舌象特征 → 老师定值”的逐项差异累计进 `tongueDiffs`，不受保留期限影响。

## backup.ts：师生互为备份

仍走现有传递层（NIP-17/44/59 信封），只加三种消息，回包一条病历一个信封：

| 消息 | 方向 | 用途 |
| :-- | :-- | :-- |
| `records.request` | 学生 → 老师 | 请老师把保留期内的该学生记录发回来 |
| `records.pull` | 老师 → 学生 | 请学生把保存的、这位老师签的病历发回来 |
| `records.backup` | 任一方向 | 回发一条签名病历 |

- 回包前一律核对发件人：老师只回请求者自己的记录；学生只回“我的老师”名单里的老师签的病历；老师端只收自己签、`p` 标签就是发件人的那份。A 学生的记录不会发给 B。V2-07 换手机后按 `identity-links` 的旧→新公钥关系放宽到“学生确认过的旧老师签的病历 / 老师确认过的旧学生名下的记录”，名单显示按新公钥归并，不重复出现同一个人。
- 自动触发：连上中继后 `autoRestore` 每天最多发一次请求（`settings/last-backup-request`）。学生打开邀请链接重新进入社区后标记 `restore-needed`，连上中继即向老师请求；老师本机没有医案、但有认得的学生的，主动逐个向学生请求。重复请求与乱序回包只会覆盖相同内容（按事件 id、版本去重）。

## 边界

- 第二版没有助记词/身份恢复：这里验证的是“本机记录被清空、身份还在”时的自动收回。身份找回（清空浏览器后换新身份）在 V2-07：靠师生互认，见 `core/reidentify/README.md`；本卡只认回本人，家人不自动恢复。
- 老师清空浏览器时，`teacher-students` 名单也会一起丢，此时无从知道向谁请求；名单在有问诊或签字时自动重建，长期保留、不受保留期限影响。
- 家人分片（`f{编号}-`）各自独立跑同一条保留期清理，规则一致。

## 验证

`app/src/core/records/records.test.ts`（9 项，全部合成身份/病历与 fake-indexeddb）：验收 0 两条路径各存一份完整病历、起草检索、改方 `previousOf`、扣费 `recordHash`；验收 1 保留 30 天第 31 天两端删除而调养方案还在，学生端收到的签名病历也按期限删、保留期内还在；验收 2 学生清空后自动收回；验收 3 老师医案丢失后从两位学生逐个收回；另加陌生发件人/回包校验与“代码里搜不到旧集合名”的扫描。
