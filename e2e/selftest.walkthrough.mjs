import { chromium, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

// V2-11 干净环境走查：按 docs/内测怎么开始.md 的八件事，用真实浏览器对临时隧道地址走一遍，
// 每步截 375px 图到 docs/screenshots/selftest-*.png。模型请求用本地固定替身（没有真实 Kimi 密钥），
// 其余（网关登记、邀请、中继、签名、钱账、门面、换机、家人）都走真实部署。
// 用法：BASE_URL=https://xxx.trycloudflare.com DEPLOY_TOKEN=xxx node e2e/selftest.walkthrough.mjs
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '')
const TOKEN = process.env.DEPLOY_TOKEN ?? ''
if (!BASE || !TOKEN) throw new Error('需要 BASE_URL 与 DEPLOY_TOKEN')
const TONGUE = root + 'app/src/core/abstractor/fixtures/tongue.png'
if (!existsSync(TONGUE)) throw new Error('缺测试用合成舌头图片')

const SYNTHETIC_DRAFT = {
  fourExams: { ask: { value: 'SYNTHETIC_EXAM' } },
  judgment: { symptomSummary: { value: 'SYNTHETIC_SUMMARY' }, pattern: { value: 'SYNTHETIC_PATTERN' } },
  plan: {
    prescription: { value: { items: [{ herb: 'SYNTHETIC_HERB', dose: 'SYNTHETIC_DOSE' }, { herb: 'SYNTHETIC_KEEP', dose: 'SYNTHETIC_DOSE' }] } },
    advice: { value: 'SYNTHETIC_ADVICE' },
    homework: [{ title: '按揉太渊穴', detail: '每天两次，每次三分钟', schedule: { kind: 'daily', time: '20:00' }, durationDays: 7 }],
  },
}
const TONGUE_REPLY = { color: 'pink', coatingColor: 'white', coatingThickness: 'thin', shape: 'standard', teeth: [], cracks: [], confidence: 0.9, box: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, lightingNote: false }

const steps = []
const findings = []
let moneyOk = false
const check = (name, detail = '') => { steps.push({ name, detail }); console.log('STEP ' + name + (detail ? ' · ' + detail : '')) }
const shot = async (page, name) => page.screenshot({ path: root + 'docs/screenshots/selftest-' + name + '.png' })
// V2-16：核对页的草稿要逐块“就这样”才能签字。
const confirmDraft = async page => {
  for (let guard = 0; guard < 12; guard += 1) {
    const draft = page.locator('.nl-review-block.draft').first()
    if (await draft.count() === 0) return
    await draft.getByRole('button', { name: '就这样', exact: true }).first().click()
  }
}

async function mockModel(context) {
  await context.route('https://api.moonshot.cn/v1/chat/completions', async route => {
    let body = {}
    try { body = JSON.parse(route.request().postData() ?? '{}') } catch { body = {} }
    const system = typeof body.messages?.[0]?.content === 'string' ? body.messages[0].content : ''
    const hasImage = (route.request().postData() ?? '').includes('image_url')
    let content
    if (hasImage || system.includes('# 舌象外观抽象')) content = JSON.stringify(TONGUE_REPLY)
    else if (system.includes('# 老师病历起草')) content = JSON.stringify(SYNTHETIC_DRAFT)
    else if (system.includes('# 老师草稿改稿')) content = JSON.stringify({ judgment: { symptomSummary: { value: 'SYNTHETIC_FINAL_SUMMARY' } } })
    else if (system.includes('# 学生每日镜子建议')) content = JSON.stringify({ today: ['今天早点睡，白天晒十分钟太阳。'] })
    else if (system.includes('# 老师调养方案起草')) content = JSON.stringify({ constitution: 'SYNTHETIC_CONSTITUTION', points: ['SYNTHETIC_PLAN_POINT'], avoid: ['SYNTHETIC_AVOID'] })
    else if (system.includes('钱账草稿')) content = JSON.stringify({ events: [{ type: 'topup', amount: '100' }] })
    else if (system.includes('# 学生问诊整理与追问')) {
      // 只把学生自己说的话填进卡片（模型只能摘原话），追问交给固定问句。
      let payload = {}
      try { payload = JSON.parse(typeof body.messages?.[1]?.content === 'string' ? body.messages[1].content : '{}') } catch { payload = {} }
      const chief = Array.isArray(payload.texts) && typeof payload.texts[0] === 'string' ? payload.texts[0] : ''
      const answers = Object.values(payload.focusAnswers ?? {}).filter(text => typeof text === 'string' && text.trim() !== '')
      content = JSON.stringify({ fields: { ...(chief ? { chiefComplaint: [chief] } : {}), ...(answers.length ? { presentIllness: answers } : {}) }, questions: [] })
    }
    else content = JSON.stringify(SYNTHETIC_DRAFT)
    if (body.stream === true) await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n' })
    else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }) })
  })
  // 天气等外部请求固定化，避免走公网拖慢走查；不影响业务流程。
  await context.route('https://geocoding-api.open-meteo.com/**', route => route.fulfill({ status: 200, body: '{}' }))
  await context.route('https://api.open-meteo.com/**', route => route.fulfill({ status: 200, body: '{}' }))
}

async function connectModel(page) {
  const guide = page.getByRole('heading', { name: '让它帮您打理馆', exact: true })
  const student = page.getByRole('heading', { name: '接入您的大模型', exact: true })
  await expect(guide.or(student)).toBeVisible({ timeout: 20000 })
  if (await guide.isVisible()) {
    await page.getByRole('button', { name: '其他', exact: true }).click()
    await page.getByLabel('接口地址', { exact: true }).fill('https://api.moonshot.cn/v1')
    await page.getByLabel('模型名称', { exact: true }).fill('synthetic-kimi')
    await page.getByLabel('模型账户密钥', { exact: true }).fill('SYNTHETIC_KIMI_KEY')
    await page.getByRole('button', { name: '测试并继续', exact: true }).click()
    await expect(page.getByRole('heading', { name: '先登记您这位老师', exact: true })).toBeVisible({ timeout: 20000 })
    return
  }
  await expect(student).toBeVisible({ timeout: 20000 })
  await page.getByLabel('选择服务商', { exact: true }).selectOption('kimi')
  await page.getByLabel('接入凭证', { exact: true }).fill('SYNTHETIC_KIMI_KEY')
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(page.getByText('✓ 连接成功', { exact: true })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: '进入首页', exact: true }).click()
}

const connected = page => expect(page.getByText('中继：已连接', { exact: true })).toBeVisible({ timeout: 90000 })

const browser = await chromium.launch({ headless: true })
let teacher, student, recovered
try {
  // ---- 老师设备 ----
  const tc = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: BASE })
  teacher = await tc.newPage()
  await mockModel(tc)
  teacher.on('pageerror', error => console.log('teacher pageerror: ' + error.message))

  const sc = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: BASE })
  student = await sc.newPage()
  await mockModel(sc)
  student.on('pageerror', error => console.log('student pageerror: ' + error.message))

  await teacher.goto('/')
  await expect(teacher.getByRole('heading', { name: '您是老师还是学生？' })).toBeVisible({ timeout: 60000 })
  await teacher.getByRole('button', { name: '我是老师', exact: true }).click()
  await connectModel(teacher)
  // V2-17：第一次进来走建馆引导（模型 → 登记 → 起名 → 开馆 → 第一位学生邀请）。
  await expect(teacher.getByRole('heading', { name: '先登记您这位老师', exact: true })).toBeVisible({ timeout: 20000 })
  await teacher.getByLabel('学生怎么称呼您', { exact: true }).fill('合成阿慈')
  await teacher.getByLabel('登记口令', { exact: true }).fill(TOKEN)
  await teacher.getByRole('button', { name: '登记，下一步', exact: true }).click()
  await expect(teacher.getByRole('heading', { name: '给您的馆起个名', exact: true })).toBeVisible({ timeout: 20000 })
  await teacher.getByLabel('馆名', { exact: true }).fill('合成养生馆')
  await teacher.getByLabel('一句介绍', { exact: true }).fill('一起照顾日常作息。')
  await expect(teacher.getByText('合成阿慈老师邀请你', { exact: true })).toBeVisible()
  await teacher.getByRole('button', { name: '就用这个名字', exact: true }).click()
  for (const label of ['模板', '排班', '邀约方式', '药材库', '保留期限', '模型']) await teacher.getByRole('button', { name: '就这样，保存' + label, exact: true }).click()
  await teacher.getByRole('button', { name: '开馆', exact: true }).click()
  await expect(teacher.getByRole('heading', { name: '请第一位学生进来', exact: true })).toBeVisible({ timeout: 20000 })
  await teacher.locator('details.op-link-details > summary').click()
  const invite = teacher.getByLabel('邀请链接', { exact: true })
  await expect(invite).toBeVisible()
  const inviteLink = await invite.inputValue()
  await shot(teacher, '02-invite-link')
  check('老师用一次性口令登记社区、起名开馆、生成第一位学生的 1 小时邀请', inviteLink.slice(0, 60) + '…')

  // ---- 学生设备 ----
  await student.goto(inviteLink)
  await expect(student.getByRole('button', { name: '开始使用', exact: true })).toBeVisible({ timeout: 20000 })
  await student.getByRole('button', { name: '开始使用', exact: true }).click()
  await connectModel(student)
  await expect(student.locator('[data-page=student-today]')).toBeVisible({ timeout: 20000 })
  await connected(student)
  await shot(student, '03-student-mirror')
  check('学生打开邀请首屏、开始使用、接入模型、进入学生首页')

  // 学生连上社区后，老师端建馆引导自动结束，进入正常首页。
  await expect(teacher.getByRole('heading', { name: '今天', exact: true })).toBeVisible({ timeout: 30000 })
  await connected(teacher)
  await shot(teacher, '01-teacher-home')
  check('第一位学生加入后，老师端自动进入首页')

  // 1. 拍舌象（学生今天 → 照镜子）
  await student.getByLabel('舌象记录的居住城市').selectOption('北京市')
  await student.getByLabel('选择舌象照片').setInputFiles(TONGUE)
  await expect(student.locator('.nl-mirror-frame svg').first()).toBeVisible({ timeout: 30000 })
  await expect(student.getByText(/原图已从应用内清除/)).toBeVisible({ timeout: 20000 })
  await shot(student, '04-tongue')
  check('学生拍舌象：只留裁剪图与候选特征，原图清除')

  // 2. 发问诊
  await student.getByRole('button', { name: /不舒服？告诉/ }).click()
  await student.getByLabel('按键盘上的🎤说话就行').fill('最近睡不好，想请老师看看')
  await student.getByRole('button', { name: '说好了，继续', exact: true }).click()
  for (let i = 0; i < 4; i += 1) {
    const skip = student.getByRole('button', { name: '跳过，直接整理', exact: true }).first()
    try { await skip.waitFor({ state: 'visible', timeout: 8000 }); await skip.click() } catch { break }
  }
  await expect(student.getByRole('region', { name: '问诊卡片' })).toBeVisible({ timeout: 20000 })
  await student.getByRole('button', { name: '改一改你的话 ›', exact: true }).click()
  await student.getByLabel('最不舒服的地方（主诉）').fill('最近睡不好')
  await student.getByLabel('现在的情况（现病史）').fill('入睡难，白天没精神')
  await student.getByLabel('以前的病（既往史）').fill('无')
  await student.getByLabel('在吃的药、过敏').fill('无')
  await student.getByRole('button', { name: /^发给/ }).click()
  await expect(student.getByRole('heading', { name: '已发给老师', exact: true })).toBeVisible({ timeout: 20000 })
  await shot(student, '05-consult-sent')
  check('学生发问诊、确认卡片、发给老师')

  // 3. 老师起草签字：今天 → 等您签字 → 核对页
  const consultRow = teacher.getByRole('button', { name: /最近睡不好/ })
  await expect(consultRow).toBeVisible({ timeout: 40000 })
  await consultRow.click()
  await expect(teacher.getByRole('heading', { name: /· 核对$/ })).toBeVisible({ timeout: 30000 })
  await teacher.getByRole('button', { name: '改善', exact: true }).click()
  await confirmDraft(teacher)
  await teacher.getByRole('button', { name: '签字发出', exact: true }).click()
  await expect(teacher.getByRole('heading', { name: '已签字交还', exact: true })).toBeVisible({ timeout: 30000 })
  await shot(teacher, '06-signed')
  await teacher.getByRole('button', { name: '返回今天', exact: true }).click()
  check('老师打开问诊、逐块确认草稿、选“和上次比 改善”、签字发出')

  // 4. 学生收到病历、打卡
  await student.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '记录', exact: true }).click()
  await expect(student.getByRole('heading', { name: '我的病历', exact: true })).toBeVisible()
  await student.getByRole('button', { name: /全部 \d+ 次/ }).click()
  await expect(student.getByText('SYNTHETIC_PATTERN', { exact: false }).first()).toBeVisible({ timeout: 30000 })
  await shot(student, '07-student-record')
  await student.getByRole('button', { name: '返回', exact: true }).click()
  await student.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '今天', exact: true }).click()
  const checkin = student.getByRole('button', { name: /打卡：/ }).first()
  await expect(checkin).toBeVisible({ timeout: 20000 })
  await checkin.click()
  await expect(checkin).toHaveAttribute('aria-pressed', 'true', { timeout: 20000 })
  await shot(student, '08-homework-checkin')
  check('学生收到签字病历与作业，完成打卡')

  // 5. 老师说一句话记账、学生看余额（V2-12：第一次确认时自动建账）
  await teacher.getByRole('button', { name: '我的馆', exact: true }).click()
  await teacher.getByRole('button', { name: '看明细 ›' }).click()
  await teacher.getByRole('button', { name: '立即对账', exact: true }).click()
  const currencySelect = teacher.getByLabel('钱账币种', { exact: true })
  await expect(currencySelect).toBeVisible({ timeout: 15000 })
  await currencySelect.selectOption('CNY')
  await teacher.getByLabel('这位学生的称呼', { exact: true }).fill('小王')
  await teacher.getByLabel('说一句话记账').fill('收到小王 100')
  await teacher.getByRole('button', { name: '生成记账草稿', exact: true }).click()
  await expect(teacher.getByRole('article', { name: '钱账确认草稿' })).toBeVisible({ timeout: 30000 })
  await teacher.getByRole('button', { name: '确认入账', exact: true }).click()
  await expect(teacher.getByText(/已记入钱账/)).toBeVisible({ timeout: 20000 })
  await shot(teacher, '09-money-teacher')
  await student.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '我', exact: true }).click()
  await student.locator('.me-balance').click()
  await student.locator('summary').filter({ hasText: /^钱账与对账$/ }).click()
  await expect(student.getByText(/钱账余额：.*100\.00/)).toBeVisible({ timeout: 30000 })
  await shot(student, '10-money-student')
  moneyOk = true
  check('老师一句话记账（真人确认入账），学生看到余额 100.00')

  // 6. 老师改门面、学生看到
  await teacher.getByRole('button', { name: '我的馆', exact: true }).click()
  await teacher.getByRole('button', { name: /门面/ }).click()
  const venue = teacher.locator('section[aria-label="我的门面"]')
  await venue.getByLabel('馆名', { exact: true }).fill('阿慈养生馆')
  await venue.getByLabel('显示称呼', { exact: true }).fill('阿慈')
  await venue.getByRole('button', { name: '用这个样子', exact: true }).click()
  await expect(teacher.getByText(/已用这个样子/)).toBeVisible({ timeout: 20000 })
  await shot(teacher, '11-storefront-teacher')
  // 学生在线时会直接收到新门面；再刷新一次确认已缓存。
  await expect(student.getByText(/阿慈养生馆 · 阿慈老师/)).toBeVisible({ timeout: 30000 })
  await student.reload()
  await expect(student.getByText(/阿慈养生馆 · 阿慈老师/)).toBeVisible({ timeout: 30000 })
  await shot(student, '12-storefront-student')
  check('老师改门面“用这个样子”，学生页首看到新馆名')

  // 7. 清空学生浏览器 + 换机找回（换手机块里生成链接；待认回也在同一个块里）
  await teacher.getByRole('button', { name: '我的馆', exact: true }).click()
  await teacher.locator('.hall-row').filter({ hasText: '设置' }).click()
  await teacher.getByRole('button', { name: /换手机/ }).click()
  const recoverSection = teacher.locator('section[aria-label="换手机找回"]')
  await recoverSection.getByLabel(/你的称呼/).fill('阿慈')
  await recoverSection.getByRole('button', { name: '生成“学生换手机”链接', exact: true }).click()
  const recoverLink = recoverSection.getByLabel(/学生换手机链接/)
  await expect(recoverLink).toBeVisible()
  const recoveryUrl = await recoverLink.inputValue()
  await shot(teacher, '13-reidentify-link')
  check('老师生成“学生换手机”链接')

  await sc.close() // 清空学生浏览器：直接换一个全新上下文（等价于清除站点数据）
  const rc = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: BASE })
  recovered = await rc.newPage()
  await mockModel(rc)
  await recovered.goto(recoveryUrl)
  await expect(recovered.getByRole('heading', { name: '找回我的记录', exact: true })).toBeVisible({ timeout: 20000 })
  await recovered.getByLabel('老师怎么称呼你').fill('小王')
  await recovered.getByRole('button', { name: '发给老师确认', exact: true }).click()
  await expect(recovered.getByText(/确认后，记录会自动回来|已发/)).toBeVisible({ timeout: 20000 })
  await shot(recovered, '14-recover-request')
  check('学生清空浏览器后打开换机链接、发“我是原来的小王”请求')

  await teacher.getByRole('button', { name: '我的馆', exact: true }).click()
  await teacher.locator('.hall-row').filter({ hasText: '设置' }).click()
  await teacher.getByRole('button', { name: /换手机/ }).click()
  const prompt = teacher.locator('section[aria-label="换手机认回请求"]')
  await expect(prompt).toBeVisible({ timeout: 30000 })
  await expect(prompt.getByText(/说他换了手机，是他吗？/)).toBeVisible()
  const pick = prompt.getByLabel('对应哪位学生')
  const options = await pick.locator('option').evaluateAll(items => items.map(item => item.value).filter(Boolean))
  await pick.selectOption(options[options.length - 1])
  await shot(teacher, '15-reidentify-prompt')
  await prompt.getByRole('button', { name: '是', exact: true }).click()
  // 老师点“是”后请求会被处理并消失；如果失败，请求区会留着错误提示。
  await expect(teacher.getByRole('region', { name: '换手机认回请求' })).toHaveCount(0, { timeout: 30000 })
  check('老师看到“小王说他换了手机，是他吗？”并点“是”')

  await expect(recovered.getByRole('button', { name: '先继续用', exact: true })).toBeVisible({ timeout: 30000 })
  await recovered.getByRole('button', { name: '先继续用', exact: true }).click()
  // 新设备还没接入模型：先按内测手册接入自己的模型，再继续。
  await connectModel(recovered)
  await expect(recovered.locator('[data-page=student-today]')).toBeVisible({ timeout: 20000 })
  await recovered.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '记录', exact: true }).click()
  await recovered.getByRole('button', { name: /全部 \d+ 次/ }).click()
  await expect(recovered.getByText('SYNTHETIC_PATTERN', { exact: false }).first()).toBeVisible({ timeout: 30000 })
  await shot(recovered, '16-recovered-records')
  if (moneyOk) {
    await recovered.getByRole('button', { name: '返回', exact: true }).click()
    await recovered.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '我', exact: true }).click()
    await recovered.locator('.me-balance').click()
    await recovered.locator('summary').filter({ hasText: /^钱账与对账$/ }).click()
    await expect(recovered.getByText(/钱账余额：.*100\.00/)).toBeVisible({ timeout: 30000 })
  }
  check('学生认回后旧病历回来' + (moneyOk ? '、余额仍是 100.00' : '（钱账入口见 finding，余额未验）'))

  // 8. 加家人 + 代家人问诊
  await recovered.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '我', exact: true }).click()
  await recovered.locator('.me-manage').click()
  await expect(recovered.getByRole('heading', { name: '家人', exact: true })).toBeVisible()
  const familyDetails = recovered.locator('details').filter({ has: recovered.getByText('添加家人', { exact: true }) })
  await familyDetails.locator('summary').click()
  await familyDetails.getByLabel('称呼', { exact: true }).fill('爸爸')
  await familyDetails.getByLabel('出生日期', { exact: true }).fill('1960-01-01')
  await familyDetails.getByLabel('居住城市').selectOption('北京市')
  await familyDetails.getByRole('button', { name: '添加家人', exact: true }).click()
  await expect(familyDetails.locator('li').filter({ hasText: '爸爸' }).first()).toBeVisible({ timeout: 20000 })
  await shot(recovered, '17-family-added')
  await recovered.getByRole('button', { name: '返回', exact: true }).click()
  await recovered.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '今天', exact: true }).click()
  await recovered.getByRole('button', { name: '爸爸', exact: true }).click()
  await shot(recovered, '18-family-switch')
  await recovered.getByRole('button', { name: /不舒服？告诉/ }).click()
  await recovered.getByLabel('按键盘上的🎤说话就行').fill('替爸爸问一下最近胃口不好')
  await recovered.getByRole('button', { name: '说好了，继续', exact: true }).click()
  for (let i = 0; i < 4; i += 1) {
    const skip = recovered.getByRole('button', { name: '跳过，直接整理', exact: true }).first()
    try { await skip.waitFor({ state: 'visible', timeout: 8000 }); await skip.click() } catch { break }
  }
  await expect(recovered.getByRole('region', { name: '问诊卡片' })).toBeVisible({ timeout: 20000 })
  await recovered.getByRole('button', { name: '改一改你的话 ›', exact: true }).click()
  await recovered.getByLabel('最不舒服的地方（主诉）').fill('替爸爸问：胃口不好')
  await recovered.getByRole('button', { name: /^发给/ }).click()
  await expect(recovered.getByRole('heading', { name: '已发给老师', exact: true })).toBeVisible({ timeout: 20000 })
  await shot(recovered, '19-family-consult')
  check('学生添加家人爸爸、切到家人、代家人发问诊')

  await teacher.getByRole('button', { name: '今天', exact: true }).click()
  const familyRow = teacher.getByRole('button', { name: /胃口不好/ })
  await expect(familyRow).toBeVisible({ timeout: 40000 })
  await familyRow.click()
  await expect(teacher.getByRole('heading', { name: /· 核对$/ })).toBeVisible({ timeout: 30000 })
  await confirmDraft(teacher)
  await teacher.getByRole('button', { name: '签字发出', exact: true }).click()
  await expect(teacher.getByRole('heading', { name: '已签字交还', exact: true })).toBeVisible({ timeout: 30000 })
  await teacher.getByRole('button', { name: '跳过评分', exact: true }).click().catch(() => {})
  check('老师收到代家人问诊并签字交还')

  await recovered.getByRole('button', { name: '回到今天', exact: true }).click()
  await recovered.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '记录', exact: true }).click()
  await recovered.getByRole('button', { name: /全部 \d+ 次/ }).click()
  await expect(recovered.getByText('替爸爸问：胃口不好', { exact: false }).first()).toBeVisible({ timeout: 30000 })
  await shot(recovered, '20-family-record')
  check('学生切到家人能看到这份病历')

  console.log('WALKTHROUGH_PASS ' + steps.length + ' steps')
  if (findings.length) for (const finding of findings) console.log('WALKTHROUGH_FINDING ' + finding)
} catch (error) {
  console.error('WALKTHROUGH_FAIL', error?.message ?? error)
  try { await teacher?.screenshot({ path: root + 'docs/screenshots/selftest-failure-teacher.png' }) } catch { /* ignore */ }
  try { await student?.screenshot({ path: root + 'docs/screenshots/selftest-failure-student.png' }) } catch { /* ignore */ }
  try { await recovered?.screenshot({ path: root + 'docs/screenshots/selftest-failure-recovered.png' }) } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  await browser.close()
}
