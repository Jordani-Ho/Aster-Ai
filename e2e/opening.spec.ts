import { test, expect, runtime, connectModel, mockModel, openCommunity } from './fixtures'
import type { Browser, APIRequestContext } from '@playwright/test'

// V2-15 建馆：全新部署走五步、第一位学生 1 小时邀请、过期重生成、老部署直接进首页。
// 真实中继 + 真实网关 + 本地模型替身，全部合成数据。
const headers = { authorization: 'Bearer ' + runtime.resetToken }
async function reset(request: APIRequestContext) {
  expect((await request.post(runtime.controlURL + '/reset', { headers, data: { communityOpen: true } })).status()).toBe(200)
}
async function freshPage(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: runtime.baseURL })
  await mockModel(context)
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '您是老师还是学生？' })).toBeVisible()
  await page.getByRole('button', { name: '我是老师', exact: true }).click()
  return { context, page }
}
function invitationExpiry(link: string): number {
  const encoded = new URL(link).hash.replace(/^#invite=/, '')
  const event = JSON.parse(Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')) as { created_at: number; tags: string[][] }
  const tag = event.tags.find(item => item[0] === 'expiration')
  return Number(tag?.[1]) - event.created_at
}

test('V2-15 全新部署：只看到引导，五步走完后第一位学生用 1 小时邀请进入，老师进正常首页', async ({ browser, request }) => {
  await reset(request)
  const teacher = await freshPage(browser)
  const page = teacher.page
  try {
    await expect(page.getByText('第 1 步，共 5 步', { exact: true })).toBeVisible()
    // 验收 3：开馆前没有管理、钱账、换门面等入口。
    expect(await page.getByRole('button', { name: '管理', exact: true }).count()).toBe(0)
    expect(await page.getByText('钱账', { exact: true }).count()).toBe(0)
    expect(await page.getByText('换门面', { exact: true }).count()).toBe(0)

    await connectModel(page)
    await expect(page.getByRole('heading', { name: '登记为社区老师', exact: true })).toBeVisible()
    await page.getByLabel('部署口令', { exact: true }).fill('SYNTHETIC_DEPLOYMENT_TOKEN')
    await page.getByRole('button', { name: '登记为社区老师', exact: true }).click()
    await expect(page.getByRole('heading', { name: '给馆起名', exact: true })).toBeVisible()

    // 验收 4：第 3 步关掉再打开，从第 3 步接着走。
    await page.reload()
    await expect(page.getByRole('heading', { name: '给馆起名', exact: true })).toBeVisible()
    await expect(page.getByText('第 3 步，共 5 步', { exact: true })).toBeVisible()

    await page.getByLabel('馆名', { exact: true }).fill('合成养生馆')
    await page.getByLabel('学生怎么称呼您', { exact: true }).fill('合成阿慈')
    await page.getByLabel('主题', { exact: true }).selectOption('cool')
    await page.getByLabel(/短介绍/).fill('一起照顾日常作息。')
    await expect(page.getByText('合成养生馆', { exact: true })).toBeVisible()
    await expect(page.getByText('合成阿慈老师邀请你', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await expect(page.getByRole('heading', { name: '开馆', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '开馆', exact: true }).click()
    await expect(page.getByRole('heading', { name: '邀请第一位学生', exact: true })).toBeVisible()

    const link = page.getByLabel('邀请链接', { exact: true })
    await expect(link).toBeVisible()
    const invite = await link.inputValue()
    expect(invitationExpiry(invite)).toBe(3600)
    expect(invite).toContain('storefront=')

    // 第二位设备：学生扫码后的同一入口（打开邀请链接 → 首屏 → 接入模型 → 镜子）。
    const studentContext = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: runtime.baseURL })
    await mockModel(studentContext)
    try {
      const student = await studentContext.newPage()
      await student.goto(invite)
      await expect(student.getByRole('heading', { name: '合成养生馆', exact: true })).toBeVisible()
      await student.getByRole('button', { name: '开始使用', exact: true }).click()
      await connectModel(student)
      await expect(student.getByRole('heading', { name: '镜子', exact: true })).toBeVisible()
      // 学生连上社区后，老师端引导自动结束。
      await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()

      // 验收 3（后段）：开馆后管理页按顺序分块、默认折叠。
      await page.getByRole('button', { name: '管理', exact: true }).click()
      const titles = await page.locator('details.manage-block > summary').allInnerTexts()
      expect(titles).toEqual(['邀请学生', '我的门面', '钱账', '记录保留多久', '换手机'])
      expect(await page.locator('details.manage-block').evaluateAll(nodes => nodes.map(node => (node as HTMLDetailsElement).open))).toEqual([false, false, false, false, false])
    } finally { await studentContext.close() }
  } finally { await teacher.context.close() }
})

test('V2-15 第一个邀请超过 1 小时：学生看到不可用，老师重新生成后可用', async ({ browser, request }) => {
  await reset(request)
  const teacher = await freshPage(browser)
  const page = teacher.page
  try {
    await connectModel(page)
    const invite = await openCommunity(page)
    expect(invitationExpiry(invite)).toBe(3600)

    // 把本机保存的邀请改成已过期，等同放置 1 小时后再打开。
    await page.evaluate(async () => {
      const storePath = '/src/core/store/index.ts', hallPath = '/src/core/hall/index.ts'
      const session = await (await import(storePath)).resumeStore()
      try {
        const { loadGuide, saveGuide } = await import(hallPath)
        const guide = await loadGuide(session.store)
        if (!guide.firstInvite) throw Error('没有第一位邀请')
        await saveGuide(session.store, { step: 5, firstInvite: { ...guide.firstInvite, expiresAt: guide.firstInvite.createdAt + 1 } })
      } finally { session.store.close(); session.identity.privateKey.fill(0) }
    })
    await page.reload()
    await expect(page.getByText('邀请已过期', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '重新生成', exact: true })).toBeVisible()

    // 旧链接：另签一张已过期的邀请，学生打开只看到“邀请暂不可用”（本机保存的链接本身仍是 1 小时签名）。
    const expiredLink = await page.evaluate(async gateway => {
      const onboardingPath = '/src/core/onboarding/index.ts', storePath = '/src/core/store/index.ts'
      const { makeInvite, inviteLink } = await import(onboardingPath)
      const session = await (await import(storePath)).resumeStore()
      try {
        const now = Math.floor(Date.now() / 1000) - 7200
        return inviteLink(location.href, makeInvite(session.identity, gateway + '/invite/redeem', now, 3600))
      } finally { session.store.close(); session.identity.privateKey.fill(0) }
    }, runtime.gatewayUrl)
    const expiredContext = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: runtime.baseURL })
    try {
      const expiredPage = await expiredContext.newPage()
      await expiredPage.goto(expiredLink)
      await expect(expiredPage.getByText('邀请暂不可用，请向老师要一个新链接', { exact: true })).toBeVisible()
    } finally { await expiredContext.close() }

    await page.getByRole('button', { name: '重新生成', exact: true }).click()
    await expect.poll(() => page.getByLabel('邀请链接', { exact: true }).inputValue()).not.toBe(invite)
    const next = await page.getByLabel('邀请链接', { exact: true }).inputValue()
    expect(next).not.toBe(invite)
    expect(invitationExpiry(next)).toBe(3600)
    const freshContext = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: runtime.baseURL })
    await mockModel(freshContext)
    try {
      const student = await freshContext.newPage()
      await student.goto(next)
      await expect(student.getByRole('heading', { name: '合成养生馆', exact: true })).toBeVisible()
    } finally { await freshContext.close() }
  } finally { await teacher.context.close() }
})

test('V2-15 老部署升级：已有学生/门面的老师直接进正常首页，不重走引导', async ({ browser, request }) => {
  await reset(request)
  const teacher = await freshPage(browser)
  const page = teacher.page
  try {
    await connectModel(page)
    await page.evaluate(async () => {
      const storePath = '/src/core/store/index.ts', teacherPath = '/src/core/records/teacher.ts'
      const session = await (await import(storePath)).resumeStore()
      try { await (await import(teacherPath)).rememberTeacherStudent(session.store, 'b'.repeat(64)) }
      finally { session.store.close(); session.identity.privateKey.fill(0) }
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
    expect(await page.getByText('第 1 步，共 5 步', { exact: true }).count()).toBe(0)
  } finally { await teacher.context.close() }
})

test('V2-13 建馆第 5 步“先进去看看”：不进邀请也能进工作台，管理里还能继续邀请', async ({ browser, request }) => {
  await reset(request)
  const teacher = await freshPage(browser)
  const page = teacher.page
  try {
    await connectModel(page)
    await openCommunity(page)
    await expect(page.getByRole('heading', { name: '邀请第一位学生', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '先进去看看', exact: true }).click()
    await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
    // 以后还能在“管理 → 邀请学生”继续邀请。
    await page.getByRole('button', { name: '管理', exact: true }).click()
    await page.locator('details.manage-block').filter({ hasText: /^邀请学生/ }).locator('summary').click()
    await page.getByRole('button', { name: '生成邀请', exact: true }).click()
    await expect(page.getByAltText('学生扫码即可加入')).toBeVisible()
  } finally { await teacher.context.close() }
})
