import type { LocalStore, StoreValue } from '../store'
import { loadTeachers } from '../inbox'
import { loadTeacherLabels, type TeacherLabels } from '../identity/teacher-labels'
import { listIdentityLinks, type IdentityLink } from '../identity/links'
import { ACTIVE_TEACHER_SETTING, displayTeacherName, loadCachedStorefronts, loadCachedTeacherCities, type Storefront } from './index'

const HEX64 = /^[0-9a-f]{64}$/

export interface TeacherVenue {
  teachers: string[]
  /** 当前在用的馆（老师公钥）。 */
  active: string | null
  labels: TeacherLabels
  venues: Record<string, Storefront>
  cities: Record<string, string | null>
  /** “阿慈老师”“老师 1a2b3c”这类显示称呼。 */
  call: string
  /** 当前馆名；没配门面时为空。 */
  name: string
}

/** 默认回到上次用的馆；那位老师不在名单里（被移除）时用“我的老师”第一位。 */
export function pickActiveTeacher(teachers: readonly string[], saved: unknown): string | null {
  const list = teachers.filter(teacher => HEX64.test(teacher))
  if (list.length === 0) return null
  if (typeof saved === 'string' && list.includes(saved)) return saved
  return list[0]
}

/** 切换当前馆只改视角与发送对象，不动已有收件/方案数据。 */
export async function saveActiveTeacher(store: Pick<LocalStore, 'put'>, teacher: string, teachers: readonly string[]): Promise<void> {
  if (!HEX64.test(teacher) || !teachers.includes(teacher)) throw new Error('没有这位老师')
  await store.put('settings', ACTIVE_TEACHER_SETTING, teacher as unknown as StoreValue)
}

export async function loadTeacherVenue(store: LocalStore): Promise<TeacherVenue> {
  const teachers = await loadTeachers(store)
  const saved = await store.get('settings', ACTIVE_TEACHER_SETTING)
  const active = pickActiveTeacher(teachers, saved)
  const [labels, venues, cities] = await Promise.all([loadTeacherLabels(store), loadCachedStorefronts(store), loadCachedTeacherCities(store)])
  const storefront = active ? venues[active] ?? null : null
  return {
    teachers,
    active,
    labels,
    venues,
    cities,
    call: active ? teacherCall(labels[active], storefront?.displayName ?? '', active) : '',
    name: storefront?.name ?? '',
  }
}

/** 学生给老师的称呼优先；没填就用老师门面里的显示称呼；都没有显示“老师 + 公钥后 6 位”。 */
export function teacherCall(label: string | undefined, displayName: string, key: string): string {
  return displayName !== '' ? displayTeacherName(displayName, key) : displayTeacherName(label ?? '', key)
}

export function venueHeading(venue: Pick<TeacherVenue, 'name' | 'call' | 'active'>): string {
  if (!venue.active) return ''
  return [venue.name, venue.call].filter(Boolean).join(' · ')
}

interface BookLike { ledger: { teacher: string; student: string } }

/** 钱账页只显示当前馆的那本；老师换手机后旧公钥那本也归到新馆。 */
export function booksForTeacher<T extends BookLike>(books: readonly T[], teacher: string | null, links: readonly IdentityLink[] = []): T[] {
  if (!teacher || !HEX64.test(teacher)) return [...books]
  return books.filter(book => book.ledger.teacher === teacher
    || links.some(link => link.kind === 'teacher' && link.newKey === teacher && link.oldKey === book.ledger.teacher))
}

export async function venueBooks<T extends BookLike>(store: Pick<LocalStore, 'list'>, books: readonly T[], teacher: string | null): Promise<T[]> {
  if (!teacher) return [...books]
  let links: IdentityLink[] = []
  try { links = await listIdentityLinks(store) } catch { links = [] }
  return booksForTeacher(books, teacher, links)
}
