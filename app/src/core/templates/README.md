# 本机四类模板版本库（V2-22）

唯一可编辑来源为 `settings/teacher-templates` 的 `{rows}` 快照。每条含 id、type、name、version、parentId、status、schema。草稿可修改；改生效版会派生新草稿；每类最多一份生效版。发布时旧版归档与新版生效在同一次 IndexedDB put 中完成，不用多行写入模拟事务。队列串行，支持 Web Locks 时也防跨标签页竞争；无 Web Locks 时仅保证单 JS 环境串行。

输入规则与默认骨架在 `domain/tcm/templates/schema.ts`，本模块只编排存取与版本。草稿保存格式校验，发布另查完整性；错误带具体段落路径。写入异常上抛“没保存成功”与原因，旧快照保留。

`templateForDrafting` 给原 `drafting/template.ts` 提供同一库的只读 TeacherTemplate 投影：问诊字段提供 focus，病历段落顺序投影到现有 Encounter 路径，四类完整骨架放 workflow 作为模型材料。模板不会扩展 Encounter 字段、改变放权档位或让模型签字。病历当前四诊、判断、处理块设为 teacher 时，起草结果保留老师原录入，不采纳模型对该块的输出；这些只读字段不存进 agent-runs。

尚无任何生效新版时，只读沿用经过原口径校验的 `settings/teacher-template`；不迁移、不双写、不再提供旧格式编辑入口。历史版本属于老师模板，不套健康记录的滚动删除期限。本卡不增加跨设备模板同步或师门模板继承。
