import type { StoreValue } from '../store'

// V2-07：学生本机给老师记一个“称呼/馆名”，用于“我的老师”列表与换机提示里显示是谁。
// 没有记录时显示“老师 + 公钥后 6 位”，不猜名字。V2-09 的馆名可以继续写这里。
export const TEACHER_LABELS_SETTING = 'teacher-labels'
export type TeacherLabels = Record<string, string>

const HEX64 = /^[0-9a-f]{64}$/
const MAX_LABEL = 20

export function validTeacherLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= MAX_LABEL && !/[\u0000-\u001f\u007f]/.test(value)
}

export interface TeacherLabelReader { get(collection: string, key: string): Promise<unknown> }
export interface TeacherLabelWriter { put(collection: string, key: string, value: unknown): Promise<void> }
export interface TeacherLabelStore extends TeacherLabelReader, TeacherLabelWriter {}

export async function loadTeacherLabels(store: TeacherLabelReader): Promise<TeacherLabels> {
  const value = await store.get('settings', TEACHER_LABELS_SETTING)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const labels: TeacherLabels = {}
  for (const [key, label] of Object.entries(value as Record<string, unknown>)) {
    if (HEX64.test(key) && validTeacherLabel(label)) labels[key] = label.trim()
  }
  return labels
}

export async function saveTeacherLabel(store: TeacherLabelStore, teacher: string, label: string): Promise<TeacherLabels> {
  if (!HEX64.test(teacher)) throw new Error('老师公钥无效')
  const labels = await loadTeacherLabels(store)
  const value = typeof label === 'string' ? label.trim() : ''
  if (value === '') delete labels[teacher]
  else {
    if (!validTeacherLabel(value)) throw new Error('称呼需要 1 至 20 个字')
    labels[teacher] = value
  }
  await store.put('settings', TEACHER_LABELS_SETTING, labels as unknown as StoreValue)
  return labels
}

/** 列表/提示里显示的老师名字：本机记的称呼优先，否则“老师 + 公钥后 6 位”。 */
export function teacherLabel(labels: TeacherLabels, teacher: string): string {
  const stored = labels[teacher]
  return validTeacherLabel(stored) ? stored.trim() : '老师 ' + teacher.slice(-6)
}
