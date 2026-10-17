# 收件分发与问诊箱（M1-15a）

`createInbox({identity, store, ledger})` 把同一个 `createTransport` 收到的信封按 `type` 分发：

- `consult.package` → 老师端问诊箱（`consult-package`），只存 `AttachmentRef`，不存照片字节。
- `consult.attachment` → 老师端附件（payload `{ encounterId, ref, data: base64 }`）。照片按 `id` + `sha256` 匹配问诊包里的引用，**现场重算 sha256**，字节长度或哈希不符就丢弃；到齐前 `assertConsultReady` 抛“照片还在路上”。
- `record.signed` → 学生端 `verifySignedEncounter`（签名人必须是这位老师）通过后写入 `student-records`，并把 `plan.homework` 写进 M1-13 的 `homework` 集合（`startsOn` 取收到当天；同一 `encounter.id` 的新版本替换旧作业，迟到的旧版本不覆盖新版本）。
- `ledger.*` → `createLedgerSync().receive`；不认识的类型丢弃。

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
