# 老师起草

`draftEncounter(pkg, template, cases, llm, options?)` 直接使用 record/types 的 Encounter 和 ConsultPackage、M1-07 的 LlmClient。调用方传入自己的已配置客户端；本模块不配置凭据、不持久化资料、不签字、不发消息。

options.level 默认 record：只允许四诊与症状摘要。pattern 再允许证候、病机、依据和治则；prescription 再允许方子、作业与医嘱。重起草从学生资料建立全新草稿，不沿用已存在的老师判断或结果。模型字段来源强制 ai_draft，缺失为 unknown/null，非法字段注明原因。

错误通过 onError 回调交给界面，并始终保留在返回病历的 judgment.symptomSummary.note 中，不把上游响应或错误原文写日志。默认等待 30 秒，可用 timeoutMs 调整。超时仅停止等待：M1-07 尚无 AbortSignal 接口，底层请求可能继续，但不会再修改返回草稿。

`searchCases(query, cases)` 只读去标识投影 DraftCase（id、symptomSummary、pattern）。NFKC 规范化后，对各连续汉字短句取去重二元组，不跨标点或空白；按共同二元组数降序，同分按 id 字典序，最多三份。无共同二元组时不匹配，单字及非汉字不计分；不是语义检索。调用者应只提供当前老师本机医案；不传完整 Encounter。存取留给 M1-11。

作业使用 main 已更新的 Homework 类型，仅在 prescription 档接纳。本机生成随机 id，强制 source=ai_draft，不接纳模型 note。逐条校验 title/detail、正整数 durationDays、四类 schedule；时间严格 HH:MM，日期须有效，时辰须为十二地支，非法条目整条丢弃，不修补。仅构造类型允许的字段，不进入签字或提醒流程。

没有 M1-05 传输代码，直接接收 ConsultPackage，历史签名与附件校验由接收层负责；本模块不解析历史病历、不读取附件二进制。

测试全部使用合成资料及模拟 LlmClient，无真实网关请求。
