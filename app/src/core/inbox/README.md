# 收件分发与问诊箱（M1-15a）

`createInbox({identity, store, ledger})` 把同一个 `createTransport` 收到的信封按 `type` 分发：

- `consult.package` → 老师端问诊箱（`consult-package`），只存 `AttachmentRef`，不存照片字节。
- `consult.attachment` → 老师端附件（payload `{ encounterId, ref, data: base64 }`）。照片按 `id` + `sha256` 匹配问诊包里的引用，**现场重算 sha256**，字节长度或哈希不符就丢弃；到齐前 `assertConsultReady` 抛“照片还在路上”。
- `record.signed` → 学生端先查“我的老师”白名单（本机 `settings` 的 `teachers`）：发件人不在名单里直接丢弃（验签、写库之前就拦住）；在名单里才 `verifySignedEncounter`（签名人必须是这位老师），通过后写入 `student-records`，并把 `plan.homework` 写进 M1-13 的 `homework` 集合（`startsOn` 取收到当天；同一 `encounter.id` 的新版本替换旧作业，迟到的旧版本不覆盖新版本）。
- `ledger.*` → `createLedgerSync().receive`；不认识的类型丢弃。

## 我的老师白名单

- 存储：`settings` 集合，键 `teachers`，值为 64 位十六进制公钥数组（校验 + 去重）。`loadTeachers` / `saveTeachers` / `addTeacher` / `removeTeacher` 是唯一读写入口。
- 收件：`receiveSignedRecord` 只在发件人属于名单时才验签入库，陌生成员签发的病历与作业都不会落库。
- 展示：`listReceivedRecords` 显示前再按名单过滤，白名单之前写进本机的旧数据同样不显示；重新登记老师后会恢复显示。
- 自动加入：`sendConsultPackage` 全部消息发送成功后把 `pkg.encounter.teacher` 加入名单（发送失败不加入）；`flushIntakeOutbox` 同样。
- 手动登记：App“设置 → 我的老师”里添加/移除（`TeacherListSettings`）。

## 发送

- `sendConsultPackage(send, pkg)`：先发问诊包（只带引用），再每张照片单独一条 `consult.attachment`（base64），避开中继单条 2 MB 上限。
- `flushIntakeOutbox(store, send)`：M1-05 接通后把 `intake-outbox` 里的替身待发件真实发出，成功后才删除。
- `completeConsultSigning`：`signEncounter` + M1-11 的 `completeSigning`（先送达、成功后才销毁问诊包与照片），送达后按需记一笔 `charge`（`recordHash` 为签名事件 id）。未送达抛 `ConsultUndeliveredError`（带事件 id），`retryConsultHandover` 重发同一条事件，不重复签字。
- `restartIntakeAfterEmergency(store, state)`：急症中断后学生点“我已知晓并重新开始”时，先删掉含急症原文的旧草稿，再开新的一次采集。

## 学生病历页

`listReceivedRecords(store, identity)` 每次展示前重新验签；`groupReceivedRecords` 按同一 `encounter.id` 归组，界面折叠保留旧版本。面诊病历的主诉用 `intakeDisplayLabel` 标“老师代录”。

## 本地集合

`consult-package`（老师端收到的问诊包，交还后删除）、`attachments`（照片字节，交还后删除）、`student-records`（学生收到的签名病历）、`homework`（M1-13 作业集合），登记在 `app/src/core/store/README.md`。

## 验证

`app/src/core/inbox/inbox.test.ts`：两个 `createTransport` + 内存中继，覆盖 6 条验收（问诊包与照片到齐、签字扣费与双端对账码、照片缺失不能起草、篡改病历不显示、每条消息通知收件人且通知失败不影响发送、375px 截图），另加 1 条加固用例（急症重启删旧草稿、intake-outbox 真实发送并删除）。全部使用合成身份、合成病历与假 LLM。

M1-15b：收到问诊包时先检查同一病历id/版本的已交还索引；存在则丢弃，避免重连时中继重放复活已删除原文。附件只接受仍有活跃问诊包的引用。新增回归测试验证交还后重放不恢复问诊包或照片；e2e进一步在真实中继重连后解密扫描全库。

M1-17：签字交还后的首次扣费会先对老师侧调用原有open，建立与该学生的空账本；然后仍按原record路径扣费，不产生充值或赠送、不改变允许欠费等规则。覆盖学生只登记本人一侧、老师首次签字后双方-3并同码的回归。
