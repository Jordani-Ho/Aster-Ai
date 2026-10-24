// 病历字段 note 的两个“已确认”来源（docs/schemas/encounter.md 第 3 节）。
// ai_accepted：老师一字未改就接受 AI 草稿 —— 只算“认可”，不当作老师的思路学。
// teacher_directed：老师让智能体按自己的意见改过、随后接受 —— 算老师改过，进相似医案。
export const AI_ACCEPTED_NOTE = 'ai_accepted'
export const TEACHER_DIRECTED_NOTE = 'teacher_directed'
