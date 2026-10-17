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

| `consult-package` | 老师端临时收到的问诊包（主诉等原文） | 键为病历 id，值为整份问诊包 | 交还学生成功后立即删除；**不得长期保留** |
| `attachments` | 问诊包里的照片/语音附件 | 键为附件 id，值为字节 | 交还学生成功后立即删除 |
| `signed-encounters` | 老师端保存的签名病历索引（不含病历内容） | 键为 `病历id-v版本`，值为 `{ eventId, encounterId, version, student, createdAt }` | 只留索引，**不留 content**；旧版本索引不覆盖 |
| `pending-handover` | 交还学生失败时暂存的待发签名病历 | 键为签名事件 id，值为 `{ event, encounter, draft, attachmentIds }` | 送达并写完后立即删除；正常流程下应短暂存在 |
| `case-book` | 去标识医案与“草案→定稿”修改记录 | `sourceEventId`、`deidentified`（性别、年龄段、判断、处理、结果）、`modifications` | 不含学生公钥、称呼、intake 原文、附件 |
| `record-log` | 诊毕即还的本地日志 | `at`（ISO 时间）、`encounterId` | 只记时间和病历 id，**不含内容** |
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
设备密钥不通过 exportKey 导出，也不写入导出容器；没有助记词或明文私钥落盘。
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
