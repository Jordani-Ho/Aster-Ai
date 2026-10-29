import type { LocalStore } from '../store'
import type { Encounter } from './types'
import { clearVisitAudio } from './visit-audio'
import { VISIT_ORIGINALS } from './visit-originals'
/** 仅在签名病历及附件全部发送成功后调用；失败后可安全重试。 */
export async function clearVisitRawMaterials(store:LocalStore, encounter:Encounter):Promise<void> {
  if (encounter.kind !== 'in_person' || !/^[0-9a-f]{32}$/.test(encounter.id)) throw Error('面诊编号无效')
  await clearVisitAudio(store,encounter.id)
  await store.delete(VISIT_ORIGINALS,encounter.id)
  await store.delete('visit-organized',encounter.id)
  const tongueCrops = new Set(encounter.intake.tongues?.flatMap(tongue => tongue.crop ? [tongue.crop.id] : []) ?? [])
  for (const attachment of encounter.intake.attachments) if (attachment.type === 'photo' && !tongueCrops.has(attachment.id)) await store.delete('attachments',attachment.id)
  await store.delete('in-person-draft',encounter.id)
}
