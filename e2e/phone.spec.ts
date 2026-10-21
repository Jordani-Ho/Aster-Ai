import { test, expect, runtime, mockModel } from './fixtures'
import type { Page } from '@playwright/test'

// V2-13：老师端 375px 手机化。真实中继/网关，模型为本地替身，全部合成数据。
async function consultations(page: Page) {
  await page.evaluate(async relay => {
    const a = '/src/core/store/index.ts', b = '/src/core/record/in-person.ts', c = '/src/core/transport/index.ts', d = '/src/core/inbox/index.ts'
    const session = await (await import(a)).resumeStore(), teachers = await session.store.get('settings', 'teachers'), { startInPersonEncounter } = await import(b), { createTransport } = await import(c), { sendConsultPackage } = await import(d)
    const channel = createTransport({ privateKey: session.identity.privateKey, relays: [relay], onMessage: () => {} }); channel.start()
    try {
      for (const [i, text] of ['SYNTHETIC_PHONE_CONSULT'].entries()) {
        const encounter = startInPersonEncounter({ teacher: teachers[0], student: session.identity.publicKey, id: (i ? 'b' : 'a').repeat(32) }); encounter.kind = 'remote_async'; encounter.intake.chiefComplaint = { value: text, source: 'student' }
        await sendConsultPackage((recipient: any, envelope: any) => channel.send(recipient, envelope), { encounter, history: [], attachments: [] })
      }
    } finally { channel.close(); session.store.close(); session.identity.privateKey.fill(0) }
  }, runtime.relayUrl)
}
async function assertPhoneLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const small = await page.locator('button:visible').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent ?? '', height: node.getBoundingClientRect().height })).filter(item => item.height < 43.5))
  expect(small).toEqual([])
}

test('V2-13 老师手机端：收到问诊到签字发出全程不横向滚动、按钮不小于 44px', async ({ people }) => {
  const teacher = people.teacher.page
  await consultations(people.student.page)
  await expect(teacher.getByRole('button', { name: '远程', exact: true })).toBeVisible()
  await assertPhoneLayout(teacher)
  await teacher.getByRole('button', { name: '远程', exact: true }).click()
  await expect(teacher.locator('.inbox-card').first()).toContainText('SYNTHETIC_PHONE_CONSULT')
  await assertPhoneLayout(teacher)
  await teacher.getByRole('button', { name: '打开问诊', exact: true }).first().click()
  await expect(teacher.getByRole('heading', { name: '病历草稿', exact: true })).toBeVisible()
  await assertPhoneLayout(teacher)
  await teacher.getByRole('button', { name: '签字发出', exact: true }).click()
  await expect(teacher.getByRole('heading', { name: '已签字交还', exact: true })).toBeVisible()
  await assertPhoneLayout(teacher)
})

test('V2-13 老师在手机上生成邀请二维码，链接可直接分享/打开，PWA 主屏幕素材可用', async ({ people, browser }) => {
  const teacher = people.teacher.page
  await teacher.getByRole('button', { name: '管理', exact: true }).click()
  await teacher.locator('details.manage-block').filter({ hasText: /^邀请学生/ }).locator('summary').click()
  await teacher.getByRole('button', { name: '生成邀请', exact: true }).click()
  await expect(teacher.getByAltText('学生扫码即可加入')).toBeVisible()
  const link = await teacher.getByLabel('邀请链接', { exact: true }).inputValue()
  expect(link).toContain('invite=')
  expect(link).toContain('storefront=')
  // 二维码可直接保存：锚点带 download 与 data:image/png；复制按钮可用。
  await expect(teacher.locator('a.invite-save')).toHaveAttribute('download', 'zhihang-invite.png')
  expect(await teacher.locator('a.invite-save').getAttribute('href')).toMatch(/^data:image\/png;base64,/)
  await assertPhoneLayout(teacher)
  // 另一位学生的设备打开同一链接，先看到老师门面首屏。
  const second = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: runtime.baseURL })
  await mockModel(second)
  try {
    const student = await second.newPage()
    await student.goto(link)
    await expect(student.getByRole('heading', { name: '合成养生馆', exact: true })).toBeVisible()
    await expect(student.getByRole('button', { name: '开始使用', exact: true })).toBeVisible()
  } finally { await second.close() }
  // PWA：启动即注册 service worker；manifest 有 192/512 PNG 与 apple-touch-icon。
  await expect.poll(async () => teacher.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration('/sw.js'))), { timeout: 15000 }).toBe(true)
  const manifest = await teacher.evaluate(async () => await (await fetch('/manifest.webmanifest')).json()) as { icons: { sizes: string; type: string }[] }
  expect(manifest.icons.some(icon => icon.sizes === '192x192' && icon.type === 'image/png')).toBe(true)
  expect(manifest.icons.some(icon => icon.sizes === '512x512' && icon.type === 'image/png')).toBe(true)
  expect(await teacher.locator('link[rel="apple-touch-icon"]').getAttribute('href')).toBe('/apple-touch-icon.png')
})

test('V2-14 社区仪表盘只读：没有钥匙不显示数据，页面上没有任何可改变馆的操作', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: runtime.baseURL })
  try {
    const page = await context.newPage()
    await page.goto('/#dashboard')
    await expect(page.getByRole('heading', { name: '社区仪表盘', exact: true })).toBeVisible()
    await expect(page.getByText('没有解密钥匙，不显示任何数据。', { exact: true })).toBeVisible()
    expect(await page.locator('button, input, select, textarea, a, form').count()).toBe(0)
  } finally { await context.close() }
})
