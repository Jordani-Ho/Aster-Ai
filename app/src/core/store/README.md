# 本机存储（V2：普通 IndexedDB，不加密）

V2 起本机存储只做普通 IndexedDB 键值存取：不派生密钥、不做 AES-GCM、不包裹私钥。数据在浏览器本地库中明文保存，隐私靠之后的抽象化与保留期限，而不是本机加密（见 `docs/product/v2-structure.md` 与 V2-01 卡）。第一版没有真实用户数据，不做迁移。

## 调用接口

```ts
import { openStore, resumeStore, clearStore } from './core/store'
const store = await openStore(identity) // 首次写入身份，之后直接可用
const id = crypto.randomUUID()
await store.put('notes', id, { text: 'synthetic' })
await store.get('notes', id) // 不存在返回 undefined
await store.list('notes') // [{ key, value }]
await store.delete('notes', id)
store.close()
const session = await resumeStore() // { identity, store }；全新数据库返回 null
const dad = store.scoped('f1-') // M1-22 家人分片：集合名加前缀，读写隔离
await store.clearScope('f1-') // 删除某位家人的全部记录
```

- 默认数据库名 `aster-local-store`，版本 1；`records` 存储 `{ c, k, v }`（集合名、键名、明文值，`c` 上有索引），`meta` 存身份：`{ privateKey(hex), publicKey, npub }`。值直接走结构化克隆，对象/数组/`Uint8Array` 都可；不可克隆的值会立即报错。
- 集合名校验 `^[a-z][a-z0-9_-]{0,63}$`，键名校验 `^[A-Za-z0-9_-]{1,64}$`；业务键仍用随机 ID，不带个人信息。
- `openStore` 只接受与库内身份一致的 `Identity`，否则报错；`resumeStore` 读回身份；`clearStore` 删除整个数据库。
- 同一实例的操作串行化；`close` 后不接受新操作。分片实例（`scoped`）不拥有数据库连接，`close` 不关库。

## 应用数据集合（登记）

V2-04 新增：`money-alias`（老师本机学生称呼，键学生公钥）、`money-drafts`（待恢复原话/待确认草稿，键学生公钥）、`settings/money-currency`（老师所在地币种）。`ledger-index` 与 `ledger-*` 继续保存钱账签名链、异议和待发队列，金额改为最小单位整数并绑定币种；不迁移旧版积分。

V2-24 新增：`herbs`（本机药材与整数最小单位库存）、`herb-ledger`（每次入库、扣减、盘点和冲回流水）、`herb-settings/units`（老师确认的钱、两换算）。老师端与学生端共用相同结构但使用各自本机存储。V2-33 远程问诊自动携带有数量的家中药材快照；学生端家人与本人共用根库存，库存余额和流水仍只保存在学生本机，不做旧数据迁移。

`kangbi-observations` 记录 id、师生、公历时刻、练习天数、老师分钟数、问诊次数和三方数值/空值。是个人健康观察记录，**长期保留、不进 V2-05 的保留期限清理**（只有计数和评分、没有内容，是将来给康币定值的依据）；不是钱账或已发行康币，生产不写 `kangbi-events`。运营端只调用匿名汇总接口。

| 集合 | 用途与字段 | 备注 |
| :-- | :-- | :-- |
| `intake-draft` | 未发送的采集草稿（键为病历 id）；V2-32 起可含学生在家拍的体态骨架 `posture`（只有关键点，无图片字节） | 确认发送或替换后删除 |
| `intake-sent` | 已发送问诊包的本机副本 `{encounter,history,attachments}` | 附件字节在 `intake-attachments` |
| `intake-outbox` | 中继未接通时暂存的问诊包 | `flushIntakeOutbox` 发送成功即删除 |
| `intake-attachments` | 采集照片处理后的 JPEG 字节（长边 ≤1600、≤500 KB）与问诊舌象的舌头裁剪图（长边 ≤512，V2-08） | 键为附件 id |
| `profile` | 学生本机档案：称呼、性别、年龄、八字、城市（键 `self`） | 城市用于天气与真太阳时/时区 |
| `basics` | V2-23 学生基础信息（键 `self`）：称呼、性别、出生日期、时辰、出生地、西医诊断、既往史、用药、过敏、作息；城市以 `profile.city` 为准 | 只留本机；老师端只经 `profile` 收到五项，西医诊断不进问诊包 |
| `basics-history` | V2-23 出生日期/时辰的修改记录（何时、旧值→新值），键为随机 id | 只留本机 |
| `student-records` | 学生收到的签名病历索引 `{id,teacher,createdAt,eventJson,version}` | 显示前重新验签；按老师设定的保留期限删除（V2-05） |
| `settings` | 键 `role`、`teachers`（老师公钥数组）、`time-display`、`mirror-shichen`、`tongue-level`（舌象抽象级别，V2-08 只开放第一级，默认 1）、`retention-days`（老师设定的保留天数）、`last-retention-day`（上次清理日）、`last-backup-request`（上次备份请求日）、`restore-needed`（新进社区后待恢复）、`reidentify-request-at`（最近一次换机请求时间）、`reidentify-rejected`（收到作废通知的时间）、`teacher-labels`（学生本机记的老师称呼/馆名）、`teacher-reidentify-open`（老师生成“老师换手机”链接的时间，30 天内才接受确认） | 家人分片内复制同一“我的老师”名单 |
| `homework` | 作业 `{homework, startsOn}` | M1-13；保留期限不删作业规则 |
| `checkins` | 打卡 `{homeworkId, at, note?, shichen?, jieqi?, city?}` | 当日 00:00–00:59 的打卡算前一天（M1-23a 子时归日）；后三项为 V2-02 天时 |
| `consult-package` | 老师端收到的问诊包（临时资料） | 按老师设定的保留期限删除 |
| `attachments` | 问诊包照片/语音字节、面诊照片、V2-08 问诊附的舌头裁剪图 | 同上；只留仍被记录引用的 |
| `in-person-draft` | 老师端进行中的面诊草稿 | 同上 |
| `teacher-records` | 老师端完整签名病历 `{eventId, encounterId, version, student, createdAt, eventJson}` | V2-05；不在则整块不存在，保留期限删除 |
| `teacher-students` | 老师认得的学生的公钥名单 `{student}` | V2-05；换手机后逐个要回病历用，不含病历内容 |
| `appointments` | 本机预约邀约、接受、确认和到场状态 | V2-25；不进中心数据库，消息经现有端到端加密中继 |
| `appointment-campaigns` | 老师本机每日邀约的候选队列与游标 | V2-25；过期或拒绝后继续请下一位 |
| `teacher-retention` | 学生端记下的每位老师的保留期限 `{teacher, days, updatedAt}`（键为老师公钥） | V2-05；多位老师取最短 |
| `teacher-fingerprint` | 老师改稿习惯摘要 `{records, paths: {字段:{drafts,changed}}, tongueDiffs: {"齿痕：模型不确定→老师有": 次数}, updatedAt}`（键为老师公钥） | V2-05/V2-08；只留计数，不受保留期限影响 |
| `identity-links` | 换手机认回关系 `{kind:'student'|'teacher', oldKey, newKey, at}`（键为旧公钥） | V2-07；只存公钥对应关系，用于名单替换与旧签名病历验签 |
| `reidentify-requests` | 老师端待确认的“学生换手机”请求 `{student, alias, receivedAt}`（键为新学生公钥） | V2-07；确认/作废后删除 |
| `reidentify-teacher-confirms` | 老师端按发件人记录的已接受 teacher 类确认 `{student, oldKey, at}`（键为学生公钥） | V2-07；同一人第二次不同旧公钥一律不认 |
| `family-reidentify` | 管理人本机记的家人认回结果 `{newKey, alias, status, oldKey?, chosenOldKey?, candidates, updatedAt}`（键为新家人公钥） | V2-07b；老师回 matched/unresolved，管理人据此显示“没找到原来的记录”并手动选旧家人 |
| `ledger-carried` | 老师换机携带过来的旧钱账 `{teacher, student, events, receivedAt}`（键为随机 id） | V2-07b；只读、按事件 id 幂等；读取时与新账归并，不按保留期限删 |
| `record-photo-index` / `record-photos` | 面诊照片索引与字节 | 学生核对签名引用后保存 |
| `care-plans` | 调养方案（键为老师公钥） | 学生端只存名单内老师签发的最新版 |
| `care-plan-pending` / `care-plan-issued` | 老师签发未送达的待发方案 / 版本索引 | |
| `mirror` | 当日镜子建议缓存 `{greeting,today,trend}` | 同一天只生成一次 |
| `self-ratings` / `self-stress` | 每日状态/压力自评 `{date,score,shichen?,jieqi?,city?}` | 同日覆盖；后三项为 V2-02 天时 |
| `tongue-records` | 每日抽象舌象 `{kind,features,svg,shichen,jieqi,city,lightingNote?,crop?}`（键 YYYY-MM-DD） | V2-08：特征可“不确定”，记录引用裁剪图；重拍覆盖当天记录 |
| `tongue-crops` | 镜子的舌头裁剪图字节 `{id, at, data}`（键为裁剪图 id） | V2-08：只留最新一张；按保留期限删，原图从不入库 |
| `tongue-failures` | 舌头拍摄失败类别 `{id, at, kind}`（kind = photo_format / no_tongue / model_unavailable / model_account / model_unsupported） | V2-20：只记类别，不存照片与模型原文；只留最近 100 条 |
| `ledger-index` / `ledger-*` | 康币账本索引与每本师生账 `{ledger,notices,conflicts,receipts,pendingDisputes,outbox}` | 单一写入者记账链 |
| `herbs` / `herb-ledger` | 本机药材与库存流水 `{id,herb,delta,reason,ref,at,balanceAfter,key}` | V2-24：老师与学生各自在本机存；整数 0.1 克或份数；不得硬删有流水的药材 |
| `herb-settings` | `units` 钱、两换算配置 | V2-24：老师确认；未配置保持 null，不猜数值 |
| `teacher-herb-snapshots` | `{ encounterId, items }` | V2-33：老师本机按问诊/病历 id 保存学生远程问诊带来的库存快照；独立于签名 `Encounter`，和对应问诊包/签名病历共享保留期限 |
| `pilot-metrics` | 试点指标 `{idPrefix,durationMs,modificationRate,missingRate,resemblance,homeworkAdherence?}` | 只有数值，无身份/原文 |
| `student-adherence` | 老师端学生本周坚持率小结（键为学生公钥） | 学生主动上报的数值，无原文 |
| `family/members` | 家人清单 `{account,alias,relation,gender,birthDate,city,publicKey,privateKey}` | 私钥直接存本机（V2 不再包裹） |
| `teacher-template` | 老师本机问诊模板 | 仅模板 |
| `settings/personal-model` | 本人模型接入 `{provider,baseUrl,model,apiKey,testedAt}` | 凭证随本机明文存储 |
| `settings/community-model` | 用社区网关模型的标记 `{mode:'gateway',testedAt}` | V2-28：不存密钥；以后接入自己的模型会清掉，以个人模型为准 |
| `posture-drafts` | 老师本机体态草稿 `PostureRecord`（键为记录 id） | V2-30：只有关键点坐标与标注，照片/视频从不入库；签字后随面诊病历保存并删草稿 |
| `settings/posture-metrics` | 老师自己的体态指标 `{id,name,formula,unit}[]` | V2-30：公式白名单校验；默认四条示例，不内置正常范围 |

M1-22 家人分片：`store.scoped('f{account}-')` 在同一个库里给集合名加前缀，实体集合名为 `f1-`、`f2-`……；根实例 `list/clearScope` 可覆盖全部分片，但 V2 不再提供整库加密导出/导入。

## 已知边界

V2-21：`agent-runs` 保存任务对象、当地日期、生成时刻、draft/delivered 状态和产出（键为 side/taskId/targetId/localDay 加可选 inputKey 的哈希），用于重载后的幂等；起草保存输入哈希、签字发送成功保存正式病历后清除该 encounter 全部起草行。含健康内容，按师生原有保留期删除。`agent-sent` 只存同任务/收件人键的最近发送尝试时刻，防跨日连发；`agent-failures` 只留最近 100 条类别与时间，不留对象、材料或模型原文。不把模型上下文另存为记忆。

- 本机数据不加密：能打开这台设备/浏览器库的人可以读取；V2 用“少留原文、按保留期限删除、由老师定保留”来控制风险（V2-03/V2-05）。
- `list()` 一次读入该集合全部记录再返回；照片等大字节集合请按需 `get`。
- 清理浏览器数据等同丢失本机资料（V2 没有助记词/身份恢复）；换手机后的记录恢复靠师生互为备份（V2-05）：记录被清空、身份还在时，连上中继会自动向老师和学生要回保留期内的记录。

V2-22：settings/teacher-templates 是四类模板版本快照（含归档链），settings/hall-groundwork 是老师时区、排班、日期例外、邀约方式、药材库准备状态与六项确认。老师本机保留配置，不上传、不迁移旧设置；模型与保留期限仍只用原设置。
