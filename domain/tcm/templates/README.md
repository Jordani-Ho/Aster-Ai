# 老师模板

TeacherTemplate 类型定义在 types.ts：id、name、recordOrder（病历字段路径字符串数组）、focus（老师特别关注的问题数组）、可选 prescriptionStyle、notes。模板只作为起草上下文，不能修改代码中的档位与来源规则。

types.ts 另提供起草日程校验用的十二时辰与24节气标准名称表，模型输出必须精确匹配，不接纳别名或首尾空白。

default-questions.json 提供每个 focus 的固定问句（模型不可用时使用），与 default.json 的 focus 一一对应；缺一个 focus 不致命，流程仍可走完。

default.json 提供十问歌默认模板：focus 按寒热、汗、头身、便、饮食、胸腹、聋、渴、旧病、因及补充项目排列；recordOrder 使用共用 Encounter 的字段路径，问诊细项在 fourExams.ask 中依 focus 顺序整理，不增加病历字段。

V2-22：schema.ts 定义 inquiry/record/treatment/prescription 的默认骨架与草稿/发布两档校验。复用旧版需求边界（字段数、文字长度、键/顺序唯一、必问、留待老师、非空施治、药味与煎法），不搬 Python/FastAPI/SQLite 代码。所有默认骨架可直接发布；默认不含药名、剂量或学生数据。未知 JSON 字段保留，拒绝非有限数值、循环、过深或超过 64KB 的内容。

TeacherTemplate.workflow 携带同一版本库的四类骨架供起草参考。现有段落 key intake/four_exams/judgment/plan 对应病历块，confirmation 留作老师核对签字；模板始终不能改变 Encounter 字段协议与来源/签字守线。旧库复核及不能整套搬的原因见 team/v2-22-legacy-verification.md。
