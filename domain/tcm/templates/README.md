# 老师模板

TeacherTemplate 类型定义在 types.ts：id、name、recordOrder（病历字段路径字符串数组）、focus（老师特别关注的问题数组）、可选 prescriptionStyle、notes。模板只作为起草上下文，不能修改代码中的档位与来源规则。

default.json 提供十问歌默认模板：focus 按寒热、汗、头身、便、饮食、胸腹、聋、渴、旧病、因及补充项目排列；recordOrder 使用共用 Encounter 的字段路径，问诊细项在 fourExams.ask 中依 focus 顺序整理，不增加病历字段。
