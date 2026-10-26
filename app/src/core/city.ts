import type { Envelope } from './transport'

/** 面诊是否同城只比较用户填写的城市名；缺失城市不拦预约。 */
export function isSameCity(studentCity: unknown, teacherCity: unknown): boolean {
  const student = typeof studentCity === 'string' ? studentCity.trim() : ''
  const teacher = typeof teacherCity === 'string' ? teacherCity.trim() : ''
  return student === '' || teacher === '' || student === teacher
}

export function validCityName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value)
}

/** 学生端每次城市变化只发送这一个字段；sendEnvelope 负责签名与端到端加密。 */
export function studentCityEnvelope(city: string | null): Envelope {
  if (city !== null && !validCityName(city)) throw new Error('城市无效')
  return { type: 'student.city', version: 1, payload: { city } }
}

export function teacherCityEnvelope(city: string | null): Envelope {
  if (city !== null && !validCityName(city)) throw new Error('城市无效')
  return { type: 'teacher.city', version: 1, payload: { city } }
}

export async function notifyTeachersOfCityChange(options: {
  identity: string
  previous: string | null
  city: string | null
  teachers: readonly string[]
  send?: (recipient: string, envelope: Envelope) => Promise<unknown>
}): Promise<number> {
  if (options.previous === options.city || !options.send) return 0
  const recipients = [...new Set(options.teachers)].filter(teacher => /^[0-9a-f]{64}$/.test(teacher) && teacher !== options.identity)
  const outcomes = await Promise.allSettled(recipients.map(teacher => options.send!(teacher, studentCityEnvelope(options.city))))
  if (outcomes.some(result => result.status === 'rejected')) throw new Error('部分老师没有收到城市更新')
  return recipients.length
}

export async function notifyStudentsOfTeacherCityChange(options: {
  identity: string
  previous: string | null
  city: string | null
  students: readonly string[]
  send?: (recipient: string, envelope: Envelope) => Promise<unknown>
}): Promise<number> {
  if (options.previous === options.city || !options.send) return 0
  const recipients = [...new Set(options.students)].filter(student => /^[0-9a-f]{64}$/.test(student) && student !== options.identity)
  const outcomes = await Promise.allSettled(recipients.map(student => options.send!(student, teacherCityEnvelope(options.city))))
  if (outcomes.some(result => result.status === 'rejected')) throw new Error('部分学生没有收到城市更新')
  return recipients.length
}
