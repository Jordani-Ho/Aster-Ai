# 本地加密存储（M1-02）

只使用浏览器 IndexedDB 和 WebCrypto，不访问网络。复用 identity/ 的 32 字节私钥。
测试依赖为获批的 fake-indexeddb@6.2.5，Apache-2.0，发布于 2025-11-07
（npm registry 时间：2025-11-07T15:23:51.459Z），仅开发依赖，版本固定。

## 调用接口

```ts
const store = await openStore(identity)
const id = crypto.randomUUID()
await store.put('notes', id, { text: 'synthetic' })
await store.get('notes', id) // 不存在返回 undefined
await store.list('notes') // [{ key, value }]，只列该集合，按 IndexedDB 键顺序
await store.delete('notes', id) // 不存在也成功
const relayBackup = await store.exportEncrypted() // 默认排除二进制
const fullBackup = await store.exportEncrypted({ includeBinary: true })
await store.importEncrypted(fullBackup, { replace: true })
store.close()
const session = await resumeStore() // { identity, store }；全新数据库返回 null
```

默认数据库名 `aster-local-store`，版本 1；单个数据库绑定一个身份，不自动覆盖其他身份。
可通过 `{ name, factory }` 注入测试数据库名及 IDBFactory。openStore 接收已核验助记词后
得到的 Identity；resumeStore 使用设备密钥恢复，不需要助记词。close 后不接受新操作，
已进入队列的操作完成后关闭连接并覆写存储实例的私钥副本；不删除持久化数据。
应用中的“返回首页”仅清除本次会话，重新打开仍可自动解锁；它不提供锁定保护。

值支持严格的 JSON 值（有限数字、字符串、布尔、null、数组、普通对象）和 Uint8Array。
不接受 undefined、BigInt、循环引用、NaN、Infinity、Date、Blob 等；Blob 由调用方先转字节。
不定义任何业务字段。集合名校验 `^[a-z][a-z0-9_-]{0,63}$`（不区分大小写），应由调用方
使用固定英文常量；键名校验 `^[A-Za-z0-9_-]{1,64}$`，调用方必须使用随机 ID，
不得包含个人信息。正则只能校验字符和长度，无法证明随机性，也无法识别英文姓名等个人信息。

## 应用数据集合（登记）

本模块不定义业务字段；下面是已接入的集合，新增业务集合时在这里登记用途与字段。

| 集合 | 用途 | 字段 | 备注 |
| :-- | :-- | :-- | :-- |
| `redflag-log` | 用户点“我已知晓”关闭急症提示后的本地日志 | `categoryId`（红线类别 id）、`action`（emergency / crisis）、`at`（ISO 时间）、`region`（地区代码或 `unknown`） | 只记录类别、时间与地区，**不含对话原文** |
| `redflag-notify` | “通知老师”的本地待发送记录，等 M1-05 接通中继后发送 | `categoryId`、`action`、`at` | 只记录类别与时间，**不含对话原文**；目前尚未真正发送 |
| `intake-draft` | 学生还没确认发送的采集草稿 | 键为病历 id，值为采集会话（学生原话、追问回答、整理字段、照片引用、轮次） | 确认发送或被替换后删除；**不外发** |
| `intake-sent` | 学生确认发送后自己的问诊包副本 | 键为病历 id，值为 `{ encounter, history, attachments }`（附件引用；字节在 `intake-attachments`） | 只留在本人手机 |
| `intake-outbox` | M1-05 未接通时暂存、待发送的问诊包 | 同上 | M1-15a 起由 `flushIntakeOutbox` 取走并真实发送，发送成功即删除 |
| `intake-attachments` | 采集照片处理后的字节（已缩到长边 ≤1600、去掉 EXIF、≤500 KB） | 键为附件 id，值为 JPEG 字节 | 随问诊包副本或待发件一起保存 |
| `profile` | 学生本机常驻档案：称呼、性别、年龄、八字、居住城市 | 键 `self`，值为 `Encounter['profile']` 的五个 Field | 随问诊包给老师；**只在本机** |
| `student-records` | 学生收到的签名病历（历史病历来源，M1-15a 收件入库） | 键为签名事件 id，值为 `{ id, teacher, createdAt, eventJson, version }` | 显示前重新验签；确认页默认附带同一位老师近 3 次；**只在本机** |
| `settings` | 本机设置 | 键 `role` 值为 `{ role: 'student' | 'teacher' }`；键 `teachers` 值为 64 位十六进制老师公钥数组（学生端“我的老师”白名单，校验+去重） | M1 由用户手动选择身份角色；学生端只接收名单内老师签发的病历，发问诊包后收件老师自动加入 |
| `homework` | M1-13 作业集合（M1-15a 收到签字病历时写入） | 值为 `{ homework, startsOn, encounterId, version }` | 同一 `encounterId` 的新版本替换旧作业 |

| `consult-package` | 老师端临时收到的问诊包（主诉等原文） | 键为病历 id，值为整份问诊包 | 交还学生成功后立即删除；**不得长期保留** |
| `attachments` | 问诊包里的照片/语音附件 | 键为附件 id，值为字节 | 交还学生成功后立即删除 |
| `signed-encounters` | 老师端保存的签名病历索引（不含病历内容） | 键为 `病历id-v版本`，值为 `{ eventId, encounterId, version, student, createdAt }` | 只留索引，**不留 content**；旧版本索引不覆盖 |
| `pending-handover` | 交还学生失败时暂存的待发签名病历 | 键为签名事件 id，值为 `{ event, encounter, draft, attachmentIds }` | 送达并写完后立即删除；正常流程下应短暂存在 |
| `case-book` | 去标识医案与“草案→定稿”修改记录 | `sourceEventId`、`deidentified`（性别、年龄段、判断、处理、结果）、`modifications` | 不含学生公钥、称呼、intake 原文、附件 |
| `record-log` | 诊毕即还的本地日志 | `at`（ISO 时间）、`encounterId` | 只记时间和病历 id，**不含内容** |
| `in-person-draft` | 老师端进行中的面诊草稿（M1-12） | 键为病历 id，值为整份 `Encounter`（含老师代录的 intake 原文与附件索引） | 签字交还成功后立即删除；中途中止需由老师手动清除 |
| `record-outbox` | 中继设置接好前的待发签名病历（M1-12） | 键为签名事件 id，值为 `{ type, payload }` | 当前只暂存在本机，中继发送接通后应删除 |
键名使用 `crypto.getRandomValues` 生成的随机十六进制 ID，不含个人信息。
## 加密格式

HKDF-SHA256 输入为身份私钥；首次初始化生成 16 字节随机 salt，info 为
`aster/local-store/v1`。派生 AES-256-GCM CryptoKey，extractable=false，仅保存在内存。
记录每次写入产生新的 12 字节随机 IV，128 位 GCM 标签随密文保存。
AAD 是 UTF-8 编码的 `集合名 + "\u0000" + 键名`，区分大小写。
明文整体为 `0x00 + UTF-8 JSON` 或 `0x01 + 原始二进制字节`；加密后才写入数据库。
读取/导入时验证 GCM 标签、类型字节与明文 bin 标记一致，失败明确报错，不返回乱码。

两个 object store：

- `records`：复合键 `[c, k]`，值 `{ c, k, iv, ct, bin }`。
- `meta`：键路径 `k`，值 `{ k, value }`，包含 `header`、`deviceKey`、`identity`。

header 为 `{ version: 1, owner, kdf: { alg: "HKDF-SHA256", salt, info } }`。
iv、ct、salt 均为标准带填充 Base64 字符串；owner 为小写十六进制公钥。
集合名、随机 ID、bin、owner、salt、词表和账户序号是明文元数据；业务内容和私钥不是明文。

## 私钥与设备密钥

首次生成或助记词恢复时，通过 WebCrypto 生成不可导出的 AES-256-GCM 设备密钥，
将 CryptoKey 结构化克隆存进 meta.deviceKey。私钥用它包裹，独立 12 字节随机 IV，
AAD 为 UTF-8 编码的 `aster/device-identity/v1\u0000{owner}\u0000{language}\u0000{account}`，
account 使用十进制整数字符串；公钥、词表和账户序号均受认证，篡改后解包失败。
meta.identity 为 `{ iv, ct, language, account }`，其中 ct 为 32 字节私钥加 GCM 标签的密文。
设备密钥不通过 exportKey 导出，也不写入导出容器；不以明文保存恢复词或私钥；M1-17的恢复词仅作为本机加密记录。
启动时读取设备密钥、解包私钥、复核公钥，再派生存储密钥。
设备密钥缺失或解包失败提示“请用助记词恢复”；使用相同助记词可重建设备密钥，保留业务密文。

防护目标是避免原始业务数据/私钥以明文存在浏览器文件中；设备 CryptoKey 的保护强度
依赖浏览器和操作系统的实现，不保证硬件隔离。不能防止已解锁手机被他人直接打开应用，
也不能防止同源恶意脚本或 XSS 使用设备密钥解密。JavaScript 字符串、垃圾回收无法保证
物理内存擦除。M2 再评估数字密码，本卡不实现。清理浏览器数据会删除设备密钥与记录，
需要助记词及后续 M1-06 备份恢复；持久化存储申请不能替代备份。

## 导出容器（供 M1-06）

exportEncrypted 返回可 JSON.stringify 的对象，importEncrypted 接受此对象或其 JSON 字符串：

```text
{
  format: "aster-store-export",
  version: 1,
  createdAt: ISO 8601 时间字符串,
  owner: 当前身份公钥十六进制,
  kdf: { alg: "HKDF-SHA256", salt: Base64, info: "aster/local-store/v1" },
  cipher: "AES-256-GCM",
  includesBinary: boolean,
  records: [{ c, k, iv: Base64, ct: Base64, bin: boolean }]
}
```

导出先验证每条密文与类型标记，再按 includeBinary 筛选，原样复制 iv/ct，不重新加密。
默认 includeBinary=false，照片/语音需完整文件备份时显式传 true。
createdAt、记录数量和元数据不构成签名；此格式不能防止删除记录或回滚整个有效旧备份。
二进制被排除后，导入只恢复容器中实际存在的记录。

导入首先在内存完成格式、版本、公钥、KDF、编码、地址、重复键和全部密文认证校验，
未知格式/版本直接拒绝。使用源 salt 派生密钥，支持跨设备恢复。
只有全部校验通过，才在一个 records+meta 的 readwrite 事务中清空、写入所有记录并替换 salt。
本地已有记录时必须显式传 replace:true，否则报错；不合并、不解决冲突。
任何认证/格式/写入错误均保留原记录和 salt；事务提交后才切换实例内存中的存储密钥。
本机设备密钥与包裹私钥不随导入替换。

同一实例的操作串行化；另一页面导入不同 salt 后，旧实例拒绝读取/写入并要求重新打开，
防止使用旧密钥写入。导入使用内存全量校验，不保证超大备份的低内存占用。

已知局限：list() 目前一次读入所有集合的记录，再仅解密目标集合；exportEncrypted()
一次读入并验证所有记录（包括照片），筛选二进制之前也会解密。M1-09 引入照片时再评估
为 records 增加集合索引，当前不实现。resumeStore 的元数据读取、校验和解包阶段
共用“请用助记词恢复”提示，暂时性存储故障也可能显示该提示；它不会自动删除数据。
本轮修正前开发版本包裹的私钥不支持自动解包，需要用原助记词重建设备包裹；
原有业务密文及存储 salt 保留，不回退到未认证词表/账户的旧 AAD。

## 验证

store.test.ts 在 fake-indexeddb 中覆盖全部 12 项验收，另覆盖未知版本、明确替换选项、
重复键、bin 篡改、错误加密密钥、事务中途失败回滚和跨会话 salt 变化。
持久化申请覆盖获准、拒绝、不支持和异常四种状态，实际界面在“设置 → 存储状态”展示。
CI 的现有 npm test 会自动执行这些用例，不需要浏览器或额外服务。

M1-13集合登记：`homework`保存`{homework, startsOn}`（共用Homework及生效日期）；`checkins`保存`{homeworkId, at, note?}`。两个集合均使用随机ID键、AES-GCM加密，只保存在本人手机，不上传或同步。

M1-06集合：backup-status保存result、lastAttempt、lastSuccess、lastFile、lastRestore和固定error；backup-config保存relays。均为随机UUID键及加密JSON，仅必要配置随加密备份恢复。

M1-14b 集合登记：

| 集合 | 用途与字段 | 备注 |
| :-- | :-- | :-- |
| ledger-index | 随机 UUID 键 -> {teacher, student, collection, key} | 值整体加密，关联不出现在集合名或键名 |
| ledger-随机32位十六进制 | 每本师生账独立集合；随机 UUID 键保存 {ledger, notices, conflicts, receipts, pendingDisputes, outbox} | ledger 含老师记账链与学生异议；conflicts 保存已验签分叉证据；receipts 保存首次收到时间、决定、迟到提示；outbox 保存待发信封。全部 AES-GCM 加密，随备份恢复 |

每本账的变更和待发记录在同一次 put 中保存，成功后才发网络；索引创建在账本记录之后。
M1 仅支持同一身份一个账本控制器；多个标签页同时写同一本账不提供业务级合并或锁。

M1-15b集合：`pilot-metrics` 使用随机UUID键，值仅为 `{idPrefix, durationMs, modificationRate, missingRate, resemblance}`（8位病历前缀与数值/null），AES-GCM本机保存。中继备份显式排除此集合，本机加密文件可包含；无病历原文、完整id、身份或照片。公式见 ../pilot/README.md。

M1-17：新增 `recovery-words/self` 保存自动生成时的恢复词，值为 `{words}`，仍由同一个本机AES-GCM库加密；中继/文件业务备份排除此集合。只在高级恢复页本人主动展开后显示。可选PRF保护启用后meta.deviceKey改存字面标志 `prf`，meta.identity由瞬时PRF派生AES-GCM包装，数据库不保留可直接解锁的CryptoKey；resumeStore要求外部临时unlockKey。未启用时保持原设备解锁格式。clearStore仅在本人勾选替换并确认恢复时调用。

M1-18 集合：`care-plans`（键为老师公钥，值 `{constitution, points, avoid, updatedAt, version}`，学生端只存“我的老师”名单内签发的调养方案，新版本替换旧版）；`tongue-photos`（键为 YYYY-MM-DD，值为压缩去 EXIF 的 JPEG 字节，每天一张、同日覆盖）；`mirror`（键为 YYYY-MM-DD，值 `{greeting, today, trend}`，当日建议缓存，同一天只生成一次）；`self-ratings`（键为 YYYY-MM-DD，值 `{date, score}`，状态自评 1～5 分，同日覆盖）；`self-stress`（键为 YYYY-MM-DD，值 `{date, score}`，压力自评 1～5 分，同日覆盖）。均 AES-GCM 本机加密；舌象字节为 bin 记录，随完整备份恢复，中继备份显式排除。

M1-20：settings 新增 teacher-template 键，值为本机 TeacherTemplate（name/focus/notes，保持默认 id 与病历顺序）；仅老师模板，沿用既有 settings 的加密、备份与恢复路径，无原始问诊或个人资料。

M1-20 调养方案集合：care-plan-pending 使用随机 UUID 键，值 {student,event}，仅签字后未成功发出时保留；发出并完成本机收尾后删除。care-plan-issued 使用随机 UUID 键，值 {student,version,eventId}，仅用于下次签发递增版本，不保留学生方案内容。老师自己的方案是本人的资料，复用 care-plans，以本人为收件人签名验签后存储。集合均 AES-GCM 加密并沿用备份恢复。

M1-20 面诊照片：record-photo-index 随机 UUID 键 -> {eventId,refId,sha256,dataKey}，record-photos 随机 UUID 键 -> 压缩去 EXIF 的 JPEG 字节。所有关联值加密，不用身份或内容哈希作明文键；学生收到有效老师签名并核对引用后才保存。照片只在学生本机和含二进制的完整加密文件备份中，中继业务备份不含字节。

M1-21：settings/personal-model -> {provider,baseUrl,model,apiKey,testedAt}，凭证与其他字段一起 AES-GCM 加密，仅本人设备保存；沿用结构化中继备份和加密文件备份。testedAt 只在本人模型连接验证成功后写入，恢复后不要求重填。设置修改未测试成功不会覆盖原记录。

## M1-22 家人子账户分片

- `store.scoped(prefix)` 在同一个加密库里返回带固定前缀的读写视图（前缀须匹配 `^[a-z][a-z0-9_-]{0,40}$`，本卡用 `f{account}-`）。集合名、键名与 AAD 都带前缀，所以每位家人的业务集合互不可见；分片实例不能导出、导入或关闭数据库连接。
- 根实例的 `exportEncrypted()` / `importEncrypted()` 覆盖全部分片：一次备份、一次恢复全家。`clearScope(prefix)` 删除某位家人的全部记录（移除家人时调用）。
- 集合登记：`family/members`（键固定 `members`，值为家人数组 `{account,alias,relation,gender,birthDate,city,publicKey,privateKey}`；privateKey 与全库一样由设备密钥保护的 AES-GCM 加密后落盘，供本机代管家人收发使用）。
- 家人分片内沿用既有集合名（`profile`、`settings`、`homework`、`student-records`、`care-plans` 等），实体集合名前缀 `f1-`、`f2-`……；分片内 `settings/teachers` 在添加家人时复制本人的“我的老师”名单。
