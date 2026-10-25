import type { LocalStore } from '../store'
import { loadGroundwork } from '../hall/groundwork'
import { deductPrescription, listHerbs, loadHerbUnits, matchPrescriptionToInventory, normalizeHerbName, parsePrescriptionDose, reversePrescription } from '../herbs'
import type { Prescription } from './types'
import type { PrescriptionLine } from '../herbs'
import { signAndHandoverInPerson, type SignInPersonOptions } from './in-person'
import type { SignedEncounterEvent } from './sign'

type SignOptions = Omit<SignInPersonOptions, 'beforeSend' | 'store'> & { store: LocalStore }
type InventoryResult = { notice: string | null; rollback?: () => Promise<void> }

/** 面诊签字始终继续；本地库存只提供扣减和签后提示，发送失败时冲回已扣库存。 */
export async function signAndHandoverInPersonWithHerbs(options: SignOptions): Promise<{ signed: SignedEncounterEvent; inventoryNotice: string | null }> {
  let inventoryNotice: string | null = null
  const signed = await signAndHandoverInPerson({
    ...options,
    beforeSend: async event => {
      const result = await prepareInventory(options.store, options.encounter.plan.prescription.value, event)
      inventoryNotice = result.notice
      return result.rollback
    },
  })
  return { signed, inventoryNotice }
}

async function prepareInventory(store: LocalStore, prescription: Prescription | null, event: SignedEncounterEvent): Promise<InventoryResult> {
  if (!prescription?.items.length) return { notice: null }

  try {
    if ((await loadGroundwork(store)).herbs === 'none') return { notice: null }

    const [herbs, units] = await Promise.all([listHerbs(store), loadHerbUnits(store)])
    const byName = new Map(herbs.map(herb => [herb.normalizedName, herb]))
    const lines: PrescriptionLine[] = []
    const skipped: string[] = []

    for (const item of prescription.items) {
      const herb = byName.get(normalizeHerbName(item.herb))
      if (!herb) continue // 库外药视为外面抓的。
      if (!herb.enabled) { skipped.push(`${herb.name}已停用`); continue }
      try {
        const parsed = parsePrescriptionDose(item.herb, item.dose)
        lines.push(matchPrescriptionToInventory([parsed], herbs, units)[0])
      } catch (cause) {
        skipped.push(`${herb.name}（${cause instanceof Error ? cause.message : '剂量无法识别'}）`)
      }
    }

    const skippedNotice = skipped.length
      ? `剂量无法识别或换算，以下药材已跳过库存扣减：${skipped.join('、')}。`
      : null
    if (!lines.length) return { notice: skippedNotice }

    const result = await deductPrescription(store, lines, event.id, 'in-person-sign-' + event.id, { units })
    if (result.shortages.length) {
      const shortages = result.shortages.map(item => `${item.herb}差 ${item.missing}${item.unit}`).join('、')
      const notice = `库存不足，这张方子没扣库存：${shortages}。请补登记后在药材库里手动扣。`
      return { notice: [notice, skippedNotice].filter(Boolean).join(' ') }
    }

    return {
      notice: skippedNotice,
      ...(result.entries.length ? {
        rollback: async () => { await reversePrescription(store, event.id, 'sign-send-failed-' + event.id) },
      } : {}),
    }
  } catch {
    return { notice: '药材库存未能核对，本次没有扣库存；请在药材库核对。' }
  }
}
