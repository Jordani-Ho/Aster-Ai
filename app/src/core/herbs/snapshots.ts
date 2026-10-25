import type { LocalStore, StoreValue } from '../store'
import { cleanSharedHomeHerbs, type SharedHomeHerb } from './index'

export const TEACHER_HERB_SNAPSHOTS = 'teacher-herb-snapshots'
const ENCOUNTER_ID = /^[a-f0-9]{32}$/

export interface TeacherHerbSnapshotStore extends Pick<LocalStore, 'get' | 'put' | 'delete'> {}

/** 快照单独按 Encounter id 存在老师端，不进入签名病历。 */
export async function saveTeacherHerbSnapshot(store: TeacherHerbSnapshotStore, encounterId: string, value: unknown): Promise<SharedHomeHerb[] | undefined> {
  if (!ENCOUNTER_ID.test(encounterId)) throw new Error('病历编号无效')
  const snapshot = cleanSharedHomeHerbs(value)
  if (!snapshot?.length) {
    await store.delete(TEACHER_HERB_SNAPSHOTS, encounterId)
    return undefined
  }
  await store.put(TEACHER_HERB_SNAPSHOTS, encounterId, { encounterId, items: snapshot } as unknown as StoreValue)
  return snapshot
}

export async function loadTeacherHerbSnapshot(store: Pick<LocalStore, 'get'>, encounterId: string): Promise<SharedHomeHerb[] | undefined> {
  if (!ENCOUNTER_ID.test(encounterId)) return undefined
  const row = await store.get(TEACHER_HERB_SNAPSHOTS, encounterId)
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined
  const value = row as { encounterId?: unknown; items?: unknown }
  if (value.encounterId !== encounterId) return undefined
  try { return cleanSharedHomeHerbs(value.items) } catch { return undefined }
}
