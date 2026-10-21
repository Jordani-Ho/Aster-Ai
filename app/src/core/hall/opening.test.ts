import { afterEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity, type Identity } from '../identity'
import { openStore, type LocalStore } from '../store'
import { publishStorefront, type Storefront } from '../storefront'
import { readInviteLink, validateInvite } from '../onboarding'
import { readStorefrontLink } from '../storefront/invite'
import { rememberTeacherStudent } from '../records/teacher'
import {
  completeHall, createFirstInvite, FIRST_INVITE_SECONDS, guideInviteExpired,
  hasOpenedHall, loadGuide, loadHall, markHallOpened, saveGuide,
} from './index'

// V2-15 建馆：全部合成身份、合成门面与 fake-indexeddb，不连中继/网关，不做数据迁移。
const NOW = new Date('2026-10-20T12:00:00.000Z')
const closers: LocalStore[] = []
const PUBLISHED: Storefront = {
  name: '合成养生馆', displayName: '合成阿慈', emblem: 'leaf', theme: 'warm',
  intro: '一起照顾日常作息。', welcome: '从每天照镜子开始。',
}

async function session(): Promise<{ identity: Identity; store: LocalStore }> {
  const identity = createIdentity()
  const store = await openStore(identity, { factory: new IDBFactory(), name: crypto.randomUUID() })
  closers.push(store)
  return { identity, store }
}

afterEach(() => { while (closers.length) closers.pop()!.close() })

describe('建馆状态与引导进度', () => {
  it('全新本机：未开馆、引导从第 1 步开始', async () => {
    const { identity, store } = await session()
    expect(await loadHall(store)).toBeNull()
    expect(await hasOpenedHall(store, identity)).toBe(false)
    expect(await loadGuide(store)).toEqual({ step: 1, firstInvite: null })
  })

  it('走到第 3 步关掉再打开，仍从第 3 步接着走', async () => {
    const { store } = await session()
    await saveGuide(store, { step: 3, firstInvite: null })
    expect(await loadGuide(store)).toEqual({ step: 3, firstInvite: null })
  })

  it('开馆写本机状态；完成第一位学生后补完成时间', async () => {
    const { identity, store } = await session()
    const opened = await markHallOpened(store, NOW.getTime())
    expect(opened).toEqual({ openedAt: NOW.toISOString(), completedAt: null })
    expect(await loadHall(store)).toEqual(opened)
    expect(await hasOpenedHall(store, identity)).toBe(true)
    const completed = await completeHall(store, NOW.getTime() + 60_000)
    expect(completed.openedAt).toBe(NOW.toISOString())
    expect(completed.completedAt).toBe(new Date(NOW.getTime() + 60_000).toISOString())
  })
})

describe('老部署直接视为已开馆', () => {
  it('已有门面的馆', async () => {
    const { identity, store } = await session()
    await publishStorefront({ store, identity, storefront: PUBLISHED, now: NOW })
    expect(await hasOpenedHall(store, identity)).toBe(true)
  })

  it('已有学生（老师认得的学生）的馆', async () => {
    const { identity, store } = await session()
    const student = createIdentity()
    await rememberTeacherStudent(store, student.publicKey)
    expect(await hasOpenedHall(store, identity)).toBe(true)
  })

  it('已有收到问诊的馆', async () => {
    const { identity, store } = await session()
    await store.put('consult-package', crypto.randomUUID(), { encounter: { id: 'a'.repeat(32) } })
    expect(await hasOpenedHall(store, identity)).toBe(true)
  })
})

describe('第一位学生的邀请', () => {
  it('开馆后生成 1 小时邀请，带门面；过期后重生成有效的', async () => {
    const { identity, store } = await session()
    await publishStorefront({ store, identity, storefront: PUBLISHED, now: NOW })
    const invite = await createFirstInvite({
      identity, store, base: 'https://synthetic.invalid/', gateway: 'https://synthetic.invalid', now: NOW.getTime(),
    })
    expect(invite.expiresAt).toBe(NOW.getTime() + FIRST_INVITE_SECONDS * 1000)
    expect(guideInviteExpired(invite, NOW.getTime() + FIRST_INVITE_SECONDS * 1000 - 1)).toBe(false)
    expect(guideInviteExpired(invite, invite.expiresAt)).toBe(true)

    const event = readInviteLink(invite.link)!
    const nowSeconds = Math.floor(NOW.getTime() / 1000)
    expect(validateInvite(event, 'https://synthetic.invalid/invite/redeem', nowSeconds)).toBe(true)
    expect(validateInvite(event, 'https://synthetic.invalid/invite/redeem', nowSeconds + FIRST_INVITE_SECONDS)).toBe(false)
    expect(readStorefrontLink(invite.link, identity.publicKey)?.storefront.name).toBe(PUBLISHED.name)

    const again = await createFirstInvite({
      identity, store, base: 'https://synthetic.invalid/', gateway: 'https://synthetic.invalid', now: NOW.getTime() + 1000,
    })
    expect(again.link).not.toBe(invite.link)
    expect(again.expiresAt).toBe(invite.expiresAt + 1000)
  })

  it('没有配置社区网关时生成失败', async () => {
    const { identity, store } = await session()
    await expect(createFirstInvite({ identity, store, base: 'https://synthetic.invalid/', gateway: '' })).rejects.toThrow()
  })
})
