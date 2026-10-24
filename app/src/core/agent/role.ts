import { AgentError, publicKey, side, type AgentSide, type AgentStore } from './tasks'
import { assertJson } from './guard'

interface BaseRole { side: AgentSide; publicKey: string; missing: string[] }
export interface TeacherRole extends BaseRole { side: 'teacher'; template: Record<string, unknown> | null; invitation: 'auto' | 'review' }
export interface StudentRole extends BaseRole { side: 'student'; currentTeacher: string | null; routine: Record<string, unknown> | null }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function loadAgentRole(store: AgentStore, owner: string, agentSide: 'teacher'): Promise<TeacherRole>
export function loadAgentRole(store: AgentStore, owner: string, agentSide: 'student'): Promise<StudentRole>
export function loadAgentRole(store: AgentStore, owner: string, agentSide?: AgentSide): Promise<TeacherRole | StudentRole>
export async function loadAgentRole(store: AgentStore, owner: string, agentSide?: AgentSide): Promise<TeacherRole | StudentRole> {
  if (!publicKey(owner)) throw new AgentError('input')
  const saved = await store.get('settings', 'role') as { role?: unknown } | undefined
  if (saved !== undefined) { if (!object(saved)) throw new AgentError('input'); side(saved.role) }
  const chosen = agentSide ?? saved?.role ?? 'student'
  side(chosen)
  const missing = !agentSide && saved === undefined ? ['role'] : []
  if (chosen === 'teacher') {
    const versions = await store.get('settings', 'teacher-templates')
    const groundwork = await store.get('settings', 'hall-groundwork')
    if (versions !== undefined && (!object(versions) || !Array.isArray(versions.rows))) throw new AgentError('input')
    const active = object(versions) && Array.isArray(versions.rows) ? versions.rows.filter(row => object(row) && row.status === 'active') : []
    const template = active.length ? Object.fromEntries(active.map(row => [row.type, row.schema])) : await store.get('settings', 'teacher-template')
    const invitation = groundwork === undefined ? await store.get('settings', 'invitation-mode') : object(groundwork) && object(groundwork.invitation) ? groundwork.invitation.mode : null
    if ((template !== undefined && !object(template)) || (invitation !== undefined && invitation !== 'auto' && invitation !== 'review')) throw new AgentError('input')
    if (template !== undefined) assertJson(template)
    if (template === undefined) missing.push('teacher-template')
    if (invitation === undefined) missing.push('invitation-mode')
    return { side: chosen, publicKey: owner, template: template === undefined ? null : structuredClone(template as Record<string, unknown>), invitation: invitation ?? 'review', missing }
  }
  const teachers = await store.get('settings', 'teachers'), current = await store.get('settings', 'active-teacher'), routine = await store.get('settings', 'agent-routine')
  if ((teachers !== undefined && (!Array.isArray(teachers) || !teachers.every(publicKey))) || (current !== undefined && !publicKey(current)) || (routine !== undefined && !object(routine))) throw new AgentError('input')
  if (routine !== undefined) assertJson(routine)
  if (current !== undefined && !(teachers as unknown[] | undefined)?.includes(current)) throw new AgentError('input')
  const currentTeacher = current as string | undefined ?? (teachers as string[] | undefined)?.[0] ?? null
  if (currentTeacher === null) missing.push('current-teacher')
  if (routine === undefined) missing.push('agent-routine')
  return { side: chosen, publicKey: owner, currentTeacher, routine: routine === undefined ? null : structuredClone(routine as Record<string, unknown>), missing }
}
