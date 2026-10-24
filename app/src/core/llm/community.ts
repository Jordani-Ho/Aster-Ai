import probe from '../../../../prompts/model-connection.md?raw'
import { createGatewayClient, ModelRequestError, type ModelGateway } from './personal'
import type { LlmClient } from './index'
import type { LocalStore, StoreValue } from '../store'

// V2-28：部署开了社区网关模型（部署者配了上游账户）时，学生先用它直接开始，不用从电脑传自己的 Key。
// 本机只记一个“用社区模型”的标记；以后在设置里接入自己的模型就以自己的为准。
export interface CommunityModel { mode: 'gateway'; testedAt: string }

const ROW = 'community-model'

function valid(value: unknown): CommunityModel | null {
  const row = value as CommunityModel | null
  if (!row || row.mode !== 'gateway' || typeof row.testedAt !== 'string' || !Number.isFinite(Date.parse(row.testedAt))) return null
  return { mode: 'gateway', testedAt: row.testedAt }
}

export async function loadCommunityModel(store: LocalStore): Promise<CommunityModel | null> {
  try { return valid(await store.get('settings', ROW)) } catch { return null }
}

export async function saveCommunityModel(store: LocalStore): Promise<CommunityModel> {
  const row: CommunityModel = { mode: 'gateway', testedAt: new Date().toISOString() }
  await store.put('settings', ROW, row as unknown as StoreValue)
  return row
}

export async function clearCommunityModel(store: LocalStore): Promise<void> {
  try { await store.delete('settings', ROW) } catch { /* 没有这个标记也算清掉了 */ }
}

export function createCommunityClient(gateway: ModelGateway, timeoutMs = 10000): LlmClient {
  return createGatewayClient(gateway, timeoutMs)
}

// 试一句再进入：部署没开社区模型时网关回 503，先告诉学生，不要卡在原地。
export async function testCommunityModel(gateway: ModelGateway): Promise<void> {
  const client = createCommunityClient(gateway, 10000)
  const text = await client.complete([{ role: 'user', content: probe.trim() }])
  if (!text.trim()) throw new ModelRequestError(502)
}

// 只按状态码说一句怎么办；不带上游原文、不显示密钥。
export function communityError(error: unknown): string {
  const status = error instanceof ModelRequestError ? error.status : 0
  if (status === 503) return '这个部署没有开社区模型：请接入自己的模型账户。'
  if (status === 401 || status === 403) return '社区模型的密钥需要部署者检查：请先接入自己的模型账户。'
  if (status === 402 || status === 429) return '社区模型账户没额度了：请让部署者检查，或先接入自己的模型账户。'
  if (status >= 500) return '社区模型暂时连不上：稍后再试，或接入自己的模型账户。'
  return '网络不通，连不上社区模型：检查网络后重试，或接入自己的模型账户。'
}
