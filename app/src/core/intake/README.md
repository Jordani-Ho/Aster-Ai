# 学生采集（M1-09）

V2-03：问诊页不再使用 `processPhoto/addPhoto` 收集原图附件；共用 `TongueCapture`，仅把严格抽象记录放入 `session.tongues` 和 `Encounter.intake.tongues`。草稿恢复、发送与老师收件沿用同一结构，最多四份。旧附件底层协议未整库重写，不是新版页面的照片入口。

学生在手机上把不舒服说清楚；智能体按老师模板追问缺的项，整理好后由学生点“确认发送”。确认前可由本人的模型账户整理必要原话；确认后才把问诊包发给老师。

## 模块

- `photo.ts`：手机拍照处理。长边缩到 ≤1600 像素、JPEG 质量 0.8 重新编码；每张 ≤500 KB（超限按 0.8 → 0.6 → 0.4 逐级降质量重编码），最多 4 张。生成 `AttachmentRef`（sha256、bytes）。只用浏览器自带能力（`createImageBitmap` + canvas），不新增依赖；测试注入 `PhotoCodec` 替身，不需要浏览器。V2 起不再逐段剥离 EXIF（canvas 重编码本身不保留原图元数据；继续逐段解析属多余层，已删）。V2-20 起返回值另带 `source`（解码出的原图尺寸）与 `image`（实际写出的尺寸）；舌象路径用 `source` 判断离得够不够近。
- `followup.ts`：追问与整理。模型可把原话改写为清楚的病历表达；每个非空字段必须引用至少一句真实原话序号，缺引用、重复引用、越界序号或字段格式不对会导致本轮回退到原话，不能把无依据内容放进整理卡。追问答案另按“问—答”保存，不混入现病史。断网或模型失败时退回原话整理与固定问句（`domain/tcm/templates/default-questions.json`），流程不中断。每轮最多问 2 项，最多 3 轮，之后直接进确认页。
- `session.ts`：采集状态机。原话逐句原样保存，另保存 AI 整理与追问；V2-18 起不判断急症或心理状况，也不产生任何标记。确认页展示整理结果（学生可修改，来源仍为 `student`）；未在确认页看过（`markReviewed`）不能进问诊包。`confirmAndSend` 只由学生点“确认发送”触发，先调用注入的 `send(pkg)`，成功且确认送达后删除本机录音、保存不含录音引用的发送副本并删除草稿。老师关闭“接收录音”时，音频引用与字节均不进新问诊包。确认发送的代码路径不调用模型。V2-32：确认页还可加 `posture`（学生在家拍的体态骨架，见 `core/posture/README.md`），草稿里只有关键点；发送时 `buildConsultPackage` 清洗后放进 `ConsultPackage.postures`，不进附件通道、不带图片字节。
- V2-26：`originals` 是问诊包里带序号的逐句原话，`organized` 是引用这些序号的四栏学生整理，`qa` 独立保存追问答案。录音限制为 `audio/mp4`、`audio/webm`、`audio/ogg`，每段最多 3 分钟、每次问诊总计 10 分钟；不支持的浏览器继续走文字。学生端仅在问诊包全部送达后删除录音字节；已发送副本不保留录音引用。老师签字并成功交还后删老师端录音字节与引用，学生端删除临时问诊包；学生智能体只留最近 5 对学生/老师整理，不留往次原话。
- `profile` / 历史病历：`buildConsultPackage` 的 `profile` 从本机常驻档案（`profile` 集合）读；历史病历从 `student-records` 集合读，默认勾选同一位老师的近 3 次（`defaultHistorySelection`），学生取消后不进包。V2-06：确认发送时把 `heavenStampOf(await heavenNow(store))` 作为 `options.heaven` 传进来，写进问诊包与病历（家人问诊用家人分片的城市）；`heaven` 可选，缺了不影响发送。

## 界面

`app/src/ConsultPage.tsx`（V2-17 按 10a–10d 重画）：老师公钥 → 说一说（输入法语音输入）→ 再问一句（可跳过）→ 看一眼问诊卡片再发出（字段、舌象、旧病历、本机档案）→ 确认发送。V2-32 起卡片页与舌象并列多一块“这次的体态（可空）”（`app/src/PostureAtHome.tsx`），拍正面/侧面各一张或一段 ≤15 秒走路视频。手机竖屏 375px 可用。问诊三步顶端都渲染 `app/src/CareReminder.tsx` 的常驻提醒；文案只在那个组件里，不能关、不拦截发送，任何情况下都不弹提醒、不显示电话号码。

## 发送边界

M1-05 未合并前，`ConsultPage` 传入的发送替身把问诊包加密写入本机 `intake-outbox`，不会外发；界面明确说“中继接通后才会交给老师”。模型客户端由 `llm` 参数注入：M1-21 在 App 注入与老师工作台相同的用户模型客户端；无可用模型时仍退回固定问句。

## 本地集合

`intake-draft`、`intake-sent`、`intake-outbox`、`intake-attachments`、`student-organization-pairs`、`profile`、`student-records`，登记在 `app/src/core/store/README.md`。录音字节只暂存在 `intake-attachments`，不留在 `intake-sent`。

## 验证

`app/src/core/intake/intake.test.ts` 覆盖确认发送边界、断网回退、附件核对、粤语合成原话与独立问答、原话引用、最近五对整理参照，以及“送达后删除学生录音”和“老师关闭接收时不带录音”。`audio.test.ts` 覆盖 MIME、分段/总时长与体积；`organization.test.ts` 覆盖缺依据、越界和重复引用。

M1-21：采集整理会把必要原话发到本人所选模型；确认发送指把问诊包交给老师，不能再声称确认前所有文字只在本机。V2-18 起采集流程不做任何急症/心理判断，只在问诊页顶端常驻一句就医提醒。

V2-40：`visit-organizer.ts` 按本馆模板整理面诊新增原话，校验六栏依据并将分段序号映射回整场面诊；不传音频或患处照片。
