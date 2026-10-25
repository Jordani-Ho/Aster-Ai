import type { LocalStore } from '../store'
import type { Prescription } from '../record/types'
import { createRunner } from '../agent/runner'
import { agentKey, defineTask } from '../agent/tasks'
import {
  assessPrescriptionStock, deductPrescription, listHerbs, loadHerbUnits, matchPrescriptionToInventory,
  parsePrescriptionDose, snapshotHomeHerbs, studentHerbReminders, type HerbUnit, type PrescriptionLine,
} from './index'

export interface StudentHerbAdvice {
  labels: { herb: string; text: string; kind: 'enough' | 'shortage' | 'buy' | 'unknown' }[]
  reminders: string[]
}

export interface StudentBrewResult {
  deducted: number
  shortages: { herb: string; missing: number; unit: HerbUnit }[]
  skipped: string[]
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  return value
}

/** 学生智能体随“记录”页打开核对库存并给出补货提醒；不调模型、不发出本机以外。 */
export async function getStudentHerbAdvice(store: LocalStore, prescription: Prescription | null, now = new Date()): Promise<StudentHerbAdvice> {
  const task = defineTask({
    id: 'herb-advice', side: 'student', trigger: { kind: 'open' }, confirm: 'template',
    gather: async () => {
      const [herbs, units] = await Promise.all([listHerbs(store), loadHerbUnits(store)])
      return { herbs, units, prescription: prescription ? structuredClone(prescription.items) : [] }
    },
    inputKey: async data => agentKey([JSON.stringify(canonical(data))]),
    tokens: () => 0,
    run: async data => {
      const snapshot = snapshotHomeHerbs(data.herbs, data.units)
      return {
        labels: assessPrescriptionStock(data.prescription, snapshot, data.units),
        reminders: studentHerbReminders(data.herbs, data.units, data.prescription),
      }
    },
    deliver: async () => {},
  })
  return (await createRunner({ store, side: 'student', maxTokens: 1 }).run(task, { targetId: 'household', now })).output
}

/** 每次明确点击“煎了一剂”就是一个独立任务；同一 actionId 重放不会重复扣减。 */
export async function brewOneWithStudentAgent(store: LocalStore, encounterId: string, prescription: Prescription, actionId: string, now = new Date()): Promise<StudentBrewResult> {
  if (!/^[a-f0-9]{32}$/.test(encounterId) || !/^[a-f0-9]{32}$/.test(actionId) || !prescription || !Array.isArray(prescription.items)) throw new Error('煎药记录输入无效')
  const task = defineTask({
    id: 'herb-brew', side: 'student', trigger: { kind: 'manual' }, confirm: 'template',
    gather: async () => ({ prescription: structuredClone(prescription), actionId }),
    inputKey: data => agentKey([data.actionId]),
    tokens: () => 0,
    run: async data => {
      const skipped: string[] = [], parsed: PrescriptionLine[] = []
      for (const item of data.prescription.items) {
        try { parsed.push(parsePrescriptionDose(item.herb, item.dose)) }
        catch { skipped.push(`${item.herb}剂量无法识别，跳过扣减：${item.dose}`) }
      }
      if (parsed.length === 0) return { deducted: 0, shortages: [], skipped }
      const [herbs, units] = await Promise.all([listHerbs(store), loadHerbUnits(store)])
      const lines = matchPrescriptionToInventory(parsed, herbs, units)
      const result = await deductPrescription(store, lines, encounterId, `brew-${data.actionId}`, { units, at: now })
      return { deducted: result.entries.length, shortages: result.shortages, skipped }
    },
    deliver: async () => {},
  })
  return (await createRunner({ store, side: 'student', maxTokens: 1 }).run(task, { targetId: encounterId, now })).output
}
