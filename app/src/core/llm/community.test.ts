import { afterEach, expect, it, vi } from 'vitest'
import { generateSecretKey } from 'nostr-tools/pure'
import {
  clearCommunityModel, communityError, createCommunityClient, loadCommunityModel,
  saveCommunityModel, testCommunityModel,
} from './community'
import { ModelRequestError } from './personal'
import type { LocalStore } from '../store'

// V2-28：部署开了社区网关模型时，学生不填自己的 Key 也能先用。
const gateway = { baseUrl: 'https://gateway.example/v1', secretKey: generateSecretKey() }
const messages = [{ role: 'user' as const, content: 'SYNTHETIC_PROMPT' }]
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'SYNTHETIC_COMMUNITY_OK' } }] }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function memoryStore(): LocalStore {
  const rows = new Map<string, unknown>()
  return {
    get: async (collection: string, key: string) => rows.get(collection + '/' + key) as never,
    put: async (collection: string, key: string, value: unknown) => { rows.set(collection + '/' + key, value) },
    delete: async (collection: string, key: string) => { rows.delete(collection + '/' + key) },
  } as unknown as LocalStore
}

it('社区模型标记：保存后能读回，清除后读不到，坏数据当没存', async () => {
  const store = memoryStore()
  expect(await loadCommunityModel(store)).toBe(null)
  const saved = await saveCommunityModel(store)
  expect(saved.mode).toBe('gateway')
  expect(Number.isFinite(Date.parse(saved.testedAt))).toBe(true)
  expect((await loadCommunityModel(store))?.mode).toBe('gateway')
  await clearCommunityModel(store)
  expect(await loadCommunityModel(store)).toBe(null)
  await store.put('settings', 'community-model', { mode: 'other', testedAt: 'x' })
  expect(await loadCommunityModel(store)).toBe(null)
  await store.put('settings', 'community-model', { mode: 'gateway', testedAt: 'not-a-date' })
  expect(await loadCommunityModel(store)).toBe(null)
})

it('社区模型请求走网关 NIP-98，不带模型名；失败只抛状态码', async () => {
  const fetch = vi.fn(async () => ok())
  vi.stubGlobal('fetch', fetch)
  expect(await createCommunityClient(gateway).complete(messages)).toBe('SYNTHETIC_COMMUNITY_OK')
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }]
  expect(url).toBe(gateway.baseUrl + '/chat/completions')
  expect(init.headers.authorization).toMatch(/^Nostr /)
  const body = JSON.parse(String(init.body))
  expect(body.model).toBeUndefined()
  expect(body.messages).toEqual(messages)

  fetch.mockResolvedValueOnce(new Response('SYNTHETIC_UPSTREAM_BODY', { status: 503 }))
  await expect(createCommunityClient(gateway).complete(messages)).rejects.toMatchObject({ status: 503 })
})

it('先用社区模型前先试一句；连不上时按“没开 / 密钥 / 额度 / 网络 / 服务商”说怎么办', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ok()))
  await expect(testCommunityModel(gateway)).resolves.toBeUndefined()

  expect(communityError(new ModelRequestError(503))).toContain('没有开社区模型')
  expect(communityError(new ModelRequestError(401))).toContain('密钥')
  expect(communityError(new ModelRequestError(402))).toContain('额度')
  expect(communityError(new ModelRequestError(429))).toContain('额度')
  expect(communityError(new ModelRequestError(500))).toContain('稍后')
  expect(communityError(new TypeError('Failed to fetch'))).toContain('网络')
  expect(communityError({})).toContain('网络')
  for (const status of [401, 402, 503, 500]) expect(communityError(new ModelRequestError(status))).not.toMatch(/SYNTHETIC|HTTP|Error/)
})
