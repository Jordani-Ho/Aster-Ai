# 本机试点指标（M1-15b）

只计算/加密保存数值并本机导出，不调用模型、不上传。`pilot-metrics` 随机UUID键保存
`idPrefix`（病历id前8位）、`durationMs`、`modificationRate`、`missingRate`、`resemblance`（1～5或null）、`homeworkAdherence`（学生本周作业坚持率 0～1 或 null，M1-23a 第 5 条；旧记录没有该字段）。
CSV固定六列（`record_id_prefix,draft_to_sign_ms,modification_rate,missing_rate,resemblance,homework_adherence`），白名单重建与范围校验阻止附加内容/公式，不含时间戳、身份、全文、照片或修改原文。坚持率只取学生端 `homework.adherence` 上报的本周数值，没有上报就留空；家人代管问诊同样按家人身份上报的数值记录。

耗时从老师点“起草”前到首次点“签字”，包括模型耗时，不包括交还耗时；当前页面重发沿用首次时间，
取消/重新起草是新一次。不记录失败的未交还操作，成功后保存一次并弹一次可跳过的评分；指标失败不阻断临床交还。
时钟回拨按0计。修改率分母是初始全部AI草稿字段数（含四诊/作业），分子严格取已有modificationLog中
内容变化的字段数；四诊按既有隐私约定不写修改日志，故不计入分子。采用时source/note变化不算内容修改。
无AI字段记0；缺失率按4个intake Field加4个四诊Field计，unknown或null均为缺失，不计附件列表。
评分跳过以空CSV单元格表示。仅保存数值；重载不重复弹评分，已保存的指标仍可导出。

中继备份明确排除此集合，本机加密文件备份可包含；恢复全库可能替换指标，CSV由本人本机保留。指标保存不触发网络请求。
