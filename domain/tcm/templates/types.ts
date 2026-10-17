export interface TeacherTemplate {
  id: string
  name: string
  recordOrder: string[]
  focus: string[]
  prescriptionStyle?: string
  notes: string
}

export const shichenNames: readonly string[] = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']
