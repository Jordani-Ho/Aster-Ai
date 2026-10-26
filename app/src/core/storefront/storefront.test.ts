import { describe, expect, it } from 'vitest'
import { finalizeEvent } from 'nostr-tools/pure'
import { IDBFactory } from 'fake-indexeddb'
import { createIdentity } from '../identity'
import { openStore, type LocalStore } from '../store'
import type { Envelope } from '../transport'
import { inviteLink, makeInvite } from '../onboarding'
import { addTeacher, createInbox } from '../inbox'
import {
  ACTIVE_TEACHER_SETTING, DEFAULT_STOREFRONT, EMBLEMS, STOREFRONT_COLLECTION, STOREFRONT_KIND,
  THEMES, displayTeacherName, inviteTitle, inviteWelcome, loadCachedStorefront, loadCachedStorefronts,
  loadCachedReceiveRecordings, loadCachedRevisitDays, loadOwnStorefront, loadStorefrontDraft, makeStorefrontEvent, normalizeStorefront, publishStorefront,
  restoreStorefront, sameStorefront, saveReceivedStorefront, saveStorefrontDraft,
  sendStorefrontTo, storefrontEnvelope, themeOf, verifyStorefrontEvent,
  type Storefront,
} from './index'
import { readStorefrontLink, storefrontInviteLink } from './invite'
import { booksForTeacher, loadTeacherVenue, pickActiveTeacher, saveActiveTeacher, teacherCall, venueHeading } from './active'
import { parseStorefrontInstruction, reviseStorefront } from './instruction'

// 只用合成身份、合成馆名，不连真实中继、不调用真实模型。
const aci = createIdentity()
const huang = createIdentity()
const stranger = createIdentity()
const student = createIdentity()

const ACI: Storefront = { name: '阿慈养生馆', displayName: '阿慈', emblem: 'leaf', theme: 'warm', intro: '一起照顾日常作息，慢慢练成适合自己的习惯。', welcome: '从每天照镜子开始。' }
const HUANG: Storefront = { name: '小黄运动馆', displayName: '小黄', emblem: 'sun', theme: 'cool', intro: '每天动一动，练完记录一下。', welcome: '今天先来十分钟。' }

const now = () => new Date('2026-10-18T09:00:00.000Z')

async function storeOf(identity = student): Promise<LocalStore> {
  return openStore(identity, { factory: new IDBFactory() })
}

describe('V2-09 门面配置与签名', () => {
  it('两份配置出两种首屏：馆名、邀请句与主题都不一样', () => {
    const left = normalizeStorefront(ACI)!
    const right = normalizeStorefront(HUANG)!
    expect(inviteTitle(left)).toBe('阿慈老师邀请你')
    expect(inviteTitle(right)).toBe('小黄老师邀请你')
    expect(themeOf(left)).not.toEqual(themeOf(right))
    expect(themeOf(left).background).toBe('#fbf7ef')
    expect(themeOf(right).background).toBe('#f2f4f7')
    // 没有显示称呼时也给出可读门牌，不露公钥。
    expect(displayTeacherName('', aci.publicKey)).toBe('老师 ' + aci.publicKey.slice(-6))
    expect(inviteTitle(null, aci.publicKey)).toBe('老师邀请你')
  })

  it('门面事件署名归老师本人；改内容或冒充都验不过', () => {
    const event = makeStorefrontEvent(aci, ACI, 1000)
    expect(event.kind).toBe(STOREFRONT_KIND)
    expect(event.pubkey).toBe(aci.publicKey)
    expect(verifyStorefrontEvent(event, aci.publicKey)?.storefront).toEqual(ACI)
    // 签名不是这位老师：不显示
    expect(verifyStorefrontEvent(event, huang.publicKey)).toBeNull()
    // 内容被改后 id 对不上
    const tampered = { ...event, content: event.content.replace('阿慈养生馆', '小黄运动馆') }
    expect(verifyStorefrontEvent(tampered, aci.publicKey)).toBeNull()
    // 陌生身份签的“阿慈养生馆”同样不认
    const forged = makeStorefrontEvent(stranger, ACI, 1000)
    expect(verifyStorefrontEvent(forged, aci.publicKey)).toBeNull()
  })

  it('老师关闭接收录音的偏好随签名门面传递；旧门面默认开启', async () => {
    const cache = await storeOf()
    const disabled = makeStorefrontEvent(aci, ACI, 3000, false)
    expect(verifyStorefrontEvent(disabled, aci.publicKey)?.receiveRecordings).toBe(false)
    expect(await saveReceivedStorefront(cache, disabled, aci.publicKey)).toBe(true)
    expect(await loadCachedReceiveRecordings(cache, aci.publicKey)).toBe(false)

    const legacySigned = finalizeEvent({
      kind: STOREFRONT_KIND, created_at: 4001, tags: [],
      content: JSON.stringify({ type: 'aster.storefront', version: 1, storefront: ACI }),
    }, aci.privateKey)
    expect(verifyStorefrontEvent(legacySigned, aci.publicKey)?.receiveRecordings).toBe(true)
    expect(await saveReceivedStorefront(cache, legacySigned, aci.publicKey)).toBe(true)
    expect(await loadCachedReceiveRecordings(cache, aci.publicKey)).toBe(true)
    cache.close()
  })

  it('老师设的复诊间隔只从签名门面读取；同一秒更新也能下发，坏数值拒收', async () => {
    const teacher = await storeOf(aci), cache = await storeOf(student)
    await teacher.put('settings', 'hall-groundwork', { invitation: { afterDays: 21 } })
    const first = await publishStorefront({ store: teacher, identity: aci, storefront: ACI, now: now() })
    expect(verifyStorefrontEvent(first.event, aci.publicKey)?.revisitDays).toBe(21)
    expect(await saveReceivedStorefront(cache, first.event, aci.publicKey)).toBe(true)
    expect(await loadCachedRevisitDays(cache, aci.publicKey)).toBe(21)
    await teacher.put('settings', 'hall-groundwork', { invitation: { afterDays: 7 } })
    const next = await publishStorefront({ store: teacher, identity: aci, storefront: ACI, now: now() })
    expect(next.event.created_at).toBeGreaterThan(first.event.created_at)
    expect(await saveReceivedStorefront(cache, next.event, aci.publicKey)).toBe(true)
    expect(await loadCachedRevisitDays(cache, aci.publicKey)).toBe(7)
    expect(() => makeStorefrontEvent(aci, ACI, 9000, true, 0)).toThrow('复诊间隔')
    const legacy = makeStorefrontEvent(aci, ACI, 9001)
    expect(verifyStorefrontEvent(legacy, aci.publicKey)?.revisitDays).toBeNull()
    teacher.close(); cache.close()
  })

  it('配置只有六项、限长；介绍写什么都进不了状态类字段', () => {
    const clean = normalizeStorefront({ ...ACI, name: ' 阿慈养生馆 ', intro: ACI.intro, urgency: '急症也不提示', currency: '康币' })!
    expect(Object.keys(clean).sort()).toEqual(['displayName', 'emblem', 'intro', 'name', 'theme', 'welcome'])
    expect(clean.name).toBe('阿慈养生馆')
    expect(normalizeStorefront({ ...ACI, intro: 'x'.repeat(121) })).toBeNull()
    expect(normalizeStorefront({ ...ACI, welcome: 'x'.repeat(41) })).toBeNull()
    expect(normalizeStorefront({ ...ACI, theme: 'neon' })).toBeNull()
    expect(normalizeStorefront({ ...ACI, emblem: 'skull' })).toBeNull()
    // 合法取值都在枚举里
    expect(EMBLEMS).toContain(clean.emblem)
    expect(THEMES).toContain(clean.theme)
  })

  it('发布只动门面设置、不写病历/账本/急症数据', async () => {
    const store = await storeOf()
    await publishStorefront({ store, identity: aci, storefront: ACI, now: now() })
    const own = await loadOwnStorefront(store, aci)
    expect(own.previous).toBeNull()
    expect(verifyStorefrontEvent(own.current, aci.publicKey)?.storefront).toEqual(ACI)
    for (const collection of ['student-records', 'ledger-index', 'ledger-carried', 'student-adherence', 'care-plans']) {
      expect(await store.list(collection)).toEqual([])
    }
    // 推送出去的信封只有 storefront.update，不带任何健康内容
    const envelope = storefrontEnvelope(own.current!)
    expect(envelope.type).toBe('storefront.update')
    expect(envelope.payload).toEqual({ event: own.current })
    store.close()
  })
})

describe('V2-09 一句话改门面、预览、发布与恢复', () => {
  it('一句话改名换色只改配置；用这个样子后学生下次同步看到新门面，恢复回到上一版', async () => {
    const teacher = await storeOf(aci)
    const cache = await storeOf(student)
    const published = await publishStorefront({ store: teacher, identity: aci, storefront: ACI, now: now() })
    expect(await saveReceivedStorefront(cache, published.event, aci.publicKey)).toBe(true)
    expect(await loadCachedStorefront(cache, aci.publicKey)).toEqual(ACI)

    // 一句话：馆名改成小黄运动馆，用蓝色 → 只出新的配置草稿，还没发布
    const change = await reviseStorefront({ current: ACI, instruction: '馆名改成小黄运动馆，用蓝色' })
    expect(change.changed).toBe(true)
    expect(change.source).toBe('rule')
    expect(change.storefront.name).toBe('小黄运动馆')
    expect(change.storefront.theme).toBe('cool')
    expect(change.storefront.intro).toBe(ACI.intro)
    await saveStorefrontDraft(teacher, change.storefront)
    expect(await loadStorefrontDraft(teacher)).toEqual(change.storefront)

    // 学生此时看到的还是旧门面（预览不是发布）
    expect(await loadCachedStorefront(cache, aci.publicKey)).toEqual(ACI)

    // 点“用这个样子”：签名发布，上一版留作恢复
    const next = await publishStorefront({ store: teacher, identity: aci, storefront: change.storefront, now: new Date('2026-10-18T09:05:00.000Z') })
    expect(next.own.previous?.id).toBe(published.event.id)
    expect(await saveReceivedStorefront(cache, next.event, aci.publicKey)).toBe(true)
    expect((await loadCachedStorefront(cache, aci.publicKey))?.name).toBe('小黄运动馆')

    // 恢复上次样子：重新签名上一版，学生端时间更新后接受
    const restored = await restoreStorefront({ store: teacher, identity: aci, now: new Date('2026-10-18T09:10:00.000Z') })
    expect(restored?.storefront).toEqual(ACI)
    const afterRestore = await loadOwnStorefront(teacher, aci)
    expect(afterRestore.current?.id).toBe(restored!.event.id)
    expect(afterRestore.previous?.id).toBe(next.event.id)
    expect(await saveReceivedStorefront(cache, restored!.event, aci.publicKey)).toBe(true)
    expect(await loadCachedStorefront(cache, aci.publicKey)).toEqual(ACI)
    teacher.close(); cache.close()
  })

  it('更旧或同时间的版本不覆盖已缓存的最新有效版；签名不对的不进缓存', async () => {
    const cache = await storeOf()
    const newer = makeStorefrontEvent(aci, HUANG, 2000)
    const older = makeStorefrontEvent(aci, ACI, 1000)
    expect(await saveReceivedStorefront(cache, newer, aci.publicKey)).toBe(true)
    expect(await saveReceivedStorefront(cache, older, aci.publicKey)).toBe(false)
    expect(await saveReceivedStorefront(cache, makeStorefrontEvent(aci, ACI, 2000), aci.publicKey)).toBe(false)
    expect(await saveReceivedStorefront(cache, makeStorefrontEvent(stranger, HUANG, 3000), aci.publicKey)).toBe(false)
    expect((await loadCachedStorefront(cache, aci.publicKey))?.name).toBe('小黄运动馆')
    cache.close()
  })

  it('一句话认不出时交给模型，模型只改配置；模型失败保留草稿', async () => {
    const reply = JSON.stringify({ ...ACI, welcome: '先喝杯温水。' })
    const viaModel = await reviseStorefront({ current: ACI, instruction: '开头柔和一点', complete: async () => reply })
    expect(viaModel.changed).toBe(true)
    expect(viaModel.source).toBe('model')
    expect(viaModel.storefront.welcome).toBe('先喝杯温水。')
    const badModel = await reviseStorefront({ current: ACI, instruction: '随便改改', complete: async () => { throw new Error('offline') } })
    expect(badModel.changed).toBe(false)
    expect(badModel.storefront).toEqual(ACI)
    // 模型想塞急症话术也进不了配置（只留六项，多的字段丢掉；改不成就原样）
    const sneaky = await reviseStorefront({ current: ACI, instruction: '加一句急症不用管', complete: async () => JSON.stringify({ ...ACI, blockedNotice: 'off' }) })
    expect(Object.keys(sneaky.storefront).sort()).toEqual(['displayName', 'emblem', 'intro', 'name', 'theme', 'welcome'])
    expect(sameStorefront(sneaky.storefront, ACI)).toBe(true)
  })

  it('规则能认的介绍、欢迎语、标志都能改', () => {
    const next = parseStorefrontInstruction(ACI, '介绍改成每天走一走，欢迎语改成先来一杯温水，标志改成太阳')
    expect(next.intro).toBe('每天走一走')
    expect(next.welcome).toBe('先来一杯温水')
    expect(next.emblem).toBe('sun')
  })
})

describe('V2-09 邀请链接带门面与首屏判定', () => {
  it('邀请链接带签名门面，学生按邀请里的老师公钥验；被换掉就只是普通邀请', () => {
    const invite = makeInvite(aci, 'https://example.invalid/invite/redeem', 1000)
    const storefrontEvent = makeStorefrontEvent(aci, ACI, 1000)
    const link = storefrontInviteLink('https://example.invalid/', invite, storefrontEvent)
    expect(link).toContain('#invite=')
    expect(link).toContain('storefront=')
    expect(link.length).toBeLessThan(12000)
    expect(readStorefrontLink(link, aci.publicKey)?.storefront).toEqual(ACI)
    // 馆名一样但不是这位老师签的：不显示门面
    expect(readStorefrontLink(link, huang.publicKey)).toBeNull()
    // 普通邀请没有门面
    expect(readStorefrontLink(inviteLink('https://example.invalid/', invite), aci.publicKey)).toBeNull()
    // 内容限长后仍能完整放进链接，不会撑爆
    const huge = { ...ACI, intro: '长'.repeat(120), welcome: '长'.repeat(40), name: '长'.repeat(20) }
    const hugeEvent = makeStorefrontEvent(aci, huge, 1000)
    const hugeLink = storefrontInviteLink('https://example.invalid/', invite, hugeEvent)
    expect(hugeLink.length).toBeLessThan(12000)
    expect(readStorefrontLink(hugeLink, aci.publicKey)?.storefront.name).toBe('长'.repeat(20))
  })

  it('新学生先看首屏；本机已经有这位老师就直接回原情境', () => {
    expect(inviteWelcome([], aci.publicKey, ACI)).toEqual({ kind: 'welcome', storefront: ACI })
    expect(inviteWelcome([huang.publicKey], aci.publicKey, null)).toEqual({ kind: 'welcome', storefront: null })
    expect(inviteWelcome([aci.publicKey], aci.publicKey, ACI)).toEqual({ kind: 'continue' })
  })
})

describe('V2-09 多老师切换与门牌', () => {
  it('默认回上次用的馆；那位老师被移除后落回第一位', async () => {
    const store = await storeOf()
    expect(pickActiveTeacher([], aci.publicKey)).toBeNull()
    expect(pickActiveTeacher([aci.publicKey, huang.publicKey], undefined)).toBe(aci.publicKey)
    expect(pickActiveTeacher([aci.publicKey, huang.publicKey], huang.publicKey)).toBe(huang.publicKey)
    expect(pickActiveTeacher([aci.publicKey], stranger.publicKey)).toBe(aci.publicKey)
    await saveActiveTeacher(store, huang.publicKey, [aci.publicKey, huang.publicKey])
    expect(await store.get('settings', ACTIVE_TEACHER_SETTING)).toBe(huang.publicKey)
    await expect(saveActiveTeacher(store, stranger.publicKey, [aci.publicKey])).rejects.toThrow()
    store.close()
  })

  it('门牌写“馆名 · 老师称呼”；钱账只显示当前馆那本', async () => {
    const venue = { name: '阿慈养生馆', call: teacherCall('阿慈', '', aci.publicKey) }
    expect(venueHeading({ ...venue, active: aci.publicKey })).toBe('阿慈养生馆 · 阿慈老师')
    expect(teacherCall('', '小黄', huang.publicKey)).toBe('小黄老师')
    expect(teacherCall('', '', huang.publicKey)).toBe('老师 ' + huang.publicKey.slice(-6))
    const books = [
      { ledger: { teacher: aci.publicKey, student: student.publicKey } },
      { ledger: { teacher: huang.publicKey, student: student.publicKey } },
    ]
    expect(booksForTeacher(books, huang.publicKey)).toEqual([books[1]])
    // 老师换手机后，旧公钥那本也算当前馆
    const links = [{ kind: 'teacher' as const, oldKey: aci.publicKey, newKey: stranger.publicKey, at: now().toISOString() }]
    expect(booksForTeacher(books, stranger.publicKey, links)).toEqual([books[0]])
    expect(booksForTeacher(books, null)).toEqual(books)
  })

  it('学生端门面缓存按老师公钥分开：两位老师各看各的馆', async () => {
    const cache = await storeOf()
    await addTeacher(cache, aci.publicKey)
    await addTeacher(cache, huang.publicKey)
    await saveReceivedStorefront(cache, makeStorefrontEvent(aci, ACI, 1000), aci.publicKey)
    await saveReceivedStorefront(cache, makeStorefrontEvent(huang, HUANG, 1000), huang.publicKey)
    const venues = await loadCachedStorefronts(cache)
    expect(venues[aci.publicKey]?.name).toBe('阿慈养生馆')
    expect(venues[huang.publicKey]?.name).toBe('小黄运动馆')
    // 学生换了当前馆，取的仍是各自门面
    await saveActiveTeacher(cache, huang.publicKey, [aci.publicKey, huang.publicKey])
    const venue = await loadTeacherVenue(cache)
    expect(venue.active).toBe(huang.publicKey)
    expect(venue.name).toBe('小黄运动馆')
    expect(venue.call).toContain('小黄')
    cache.close()
  })
})

describe('V2-09 收件：学生只收名单里老师本人发的最新门面', () => {
  it('老师发来的 storefront.update 进缓存；陌生身份、冒名、更旧版本都不收', async () => {
    const store = await storeOf(student)
    await store.put('settings', 'role', { role: 'student' })
    await addTeacher(store, aci.publicKey)
    const inbox = createInbox({ identity: student, store })
    const deliver = async (sender: string, event: ReturnType<typeof makeStorefrontEvent>) => {
      await inbox.receive({ id: crypto.randomUUID(), at: 1, sender, envelope: storefrontEnvelope(event) })
    }
    await deliver(aci.publicKey, makeStorefrontEvent(aci, ACI, 1000))
    expect(await loadCachedStorefront(store, aci.publicKey)).toEqual(ACI)
    // 更旧的门面不覆盖已缓存的有效版
    await deliver(aci.publicKey, makeStorefrontEvent(aci, HUANG, 900))
    expect((await loadCachedStorefront(store, aci.publicKey))?.name).toBe('阿慈养生馆')
    // 陌生身份发来的不收
    await deliver(stranger.publicKey, makeStorefrontEvent(stranger, HUANG, 2000))
    expect(await loadCachedStorefront(store, stranger.publicKey)).toBeNull()
    // 老师转发别人签的“阿慈养生馆”也不收（签名人不是名单里的老师）
    await deliver(aci.publicKey, makeStorefrontEvent(stranger, HUANG, 3000))
    expect(await loadCachedStorefront(store, stranger.publicKey)).toBeNull()
    // 老师自己发的新一版才收
    await deliver(aci.publicKey, makeStorefrontEvent(aci, HUANG, 4000))
    expect((await loadCachedStorefront(store, aci.publicKey))?.name).toBe('小黄运动馆')
    store.close()
  })
})

describe('V2-09 下发与兜底', () => {
  it('老师把当前门面发给已知学生；没配过门面就什么都不发', async () => {
    const teacher = await storeOf(aci)
    const sent: { recipient: string; envelope: Envelope }[] = []
    const send = async (recipient: string, envelope: Envelope) => { sent.push({ recipient, envelope }) }
    const before = await sendStorefrontTo({ store: teacher, identity: aci, recipients: [student.publicKey], send })
    expect(before).toBe(0)
    await publishStorefront({ store: teacher, identity: aci, storefront: ACI, now: now() })
    const after = await sendStorefrontTo({ store: teacher, identity: aci, recipients: [student.publicKey, student.publicKey, aci.publicKey, 'bad'], send })
    expect(after).toBe(2)
    expect(sent.every(item => item.envelope.type === 'storefront.update')).toBe(true)
    teacher.close()
  })

  it('没有上一版时“恢复上次样子”不做任何事', async () => {
    const store = await storeOf(aci)
    expect(await restoreStorefront({ store, identity: aci, now: now() })).toBeNull()
    store.close()
  })

  it('断网时用上次收到的门面；没收到过就返回空，界面回落简洁默认样式', async () => {
    const cache = await storeOf()
    expect(await loadCachedStorefront(cache, aci.publicKey)).toBeNull()
    await saveReceivedStorefront(cache, makeStorefrontEvent(aci, ACI, 1000), aci.publicKey)
    expect(await loadCachedStorefront(cache, aci.publicKey)).toEqual(ACI)
    expect(DEFAULT_STOREFRONT.name).toBe('')
    expect(themeOf(null).background).toBe('#fbf7ef')
    expect((await cache.list(STOREFRONT_COLLECTION)).length).toBe(1)
    cache.close()
  })
})
