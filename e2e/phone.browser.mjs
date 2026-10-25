import { chromium, expect as baseExpect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'
const expect = baseExpect.configure({ timeout: 20000 })
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const server = await createServer({ configFile: root + 'app/vite.config.ts', root: root + 'app', server: { host: '127.0.0.1', port: 0 }, resolve: { alias: { react: root + 'app/node_modules/react', 'react-dom': root + 'app/node_modules/react-dom' } }, define: { 'import.meta.env.VITE_DASHBOARD_PUBKEY': JSON.stringify('d'.repeat(64)), 'import.meta.env.VITE_DASHBOARD_URL': JSON.stringify('https://phone.synthetic.invalid/#dashboard') } })
await server.listen()
const browser = await chromium.launch({ headless: true })

async function open(scene) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, permissions: ['clipboard-read', 'clipboard-write'], ...(scene === 'student' ? { timezoneId: 'UTC' } : {}) })
  await context.addInitScript(() => { window.__shared = null; if (navigator.share) return; Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__shared = data } }) })
  const page = await context.newPage()
  // 子时的“今天”归前一天；固定在边界内，确保合成作业与页面使用同一有效日。
  if (scene === 'student') await page.clock.setFixedTime(new Date('2026-10-25T00:30:00Z'))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/chat/completions', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '合成模型回答' } }] }) }))
  await page.route('https://phone.synthetic.invalid/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/@fs/${root}e2e/phone.html?scene=${scene}`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(scene === 'today' ? 2500 : 600)
  return { context, page, errors }
}
async function layout(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const small = await page.locator('button:visible').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent ?? '', height: node.getBoundingClientRect().height })).filter(item => item.height < 43.5))
  expect(small).toEqual([])
}
async function shot(page, name) { if (!process.env.CI) await page.screenshot({ path: root + 'docs/screenshots/' + name + '.png' }) }
const FIRST_AID = '急症请立即去医院或拨打当地急救电话，别等老师回复。'
const PHONE_NUMBERS = ['120', '911', '999', '119', '995', '988']
async function expectNoPhoneNumbers(page) {
  const body = await page.locator('body').innerText()
  for (const number of PHONE_NUMBERS) expect(body).not.toContain(number)
}
// 整理后可能先出追问，也可能直接到卡片；两种都往下走，每一步都应看到常驻提醒。
async function skipToCard(page) {
  const card = page.getByRole('region', { name: '问诊卡片' })
  const skip = page.getByRole('button', { name: '跳过，直接整理', exact: true }).first()
  for (let guard = 0; guard < 5; guard += 1) {
    let state = 'none'
    for (let tick = 0; tick < 120 && state === 'none'; tick += 1) {
      if (await card.count()) state = 'card'
      else if (await skip.count()) state = 'skip'
      else await page.waitForTimeout(250)
    }
    await expect(page.getByText(FIRST_AID, { exact: true })).toBeVisible()
    if (state === 'card') return card
    if (state === 'none') break
    await skip.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(300)
  }
  await expect(card).toBeVisible()
  return card
}

try {
  // 05a–05e：建馆五步逐页截图（合成数据、模型已接好的状态由场景预置）
  {
    const scenes = [
      ['open1', '让它帮您打理馆', 'phone-teacher-opening-model'],
      ['open2', '先登记您这位老师', 'phone-teacher-opening-register'],
      ['open3', '给您的馆起个名', 'phone-teacher-opening-name'],
      ['open4', '您的馆准备好了', 'phone-teacher-opening-open'],
      ['open5', '请第一位学生进来', 'phone-teacher-opening-invite'],
    ]
    for (const [scene, title, name] of scenes) {
      const { context, page, errors } = await open(scene)
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible()
      if (scene === 'open5') {
        await expect(page.getByText('这份邀请 1 小时有效', { exact: true })).toBeVisible()
        await page.locator('details.op-link-details > summary').click()
        await expect(page.getByLabel('邀请链接', { exact: true })).toHaveValue(/invite=/)
      }
      await layout(page)
      await shot(page, name)
      expect(errors).toEqual([])
      await context.close()
    }
  }
  // 验收 2：全新部署走完建馆五步（模型 → 登记 → 起馆名 → 开馆 → 邀请），先进去看看。
  {
    const { context, page, errors } = await open('opening')
    await expect(page.getByRole('heading', { name: '让它帮您打理馆', exact: true })).toBeVisible()
    await expect(page.getByText('建馆 · 第 1 / 5 步', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '其他', exact: true }).click()
    await page.getByLabel('接口地址', { exact: true }).fill('https://model.synthetic.invalid/v1')
    await page.getByLabel('模型名称', { exact: true }).fill('synthetic')
    await page.getByLabel('模型账户密钥', { exact: true }).fill('SYNTHETIC')
    await page.getByRole('button', { name: '测试并继续', exact: true }).click()
    await expect(page.getByRole('heading', { name: '先登记您这位老师', exact: true })).toBeVisible()
    await page.getByLabel('学生怎么称呼您', { exact: true }).fill('合成阿慈')
    await page.getByLabel('登记口令', { exact: true }).fill('SYNTHETIC_DEPLOYMENT_TOKEN')
    await page.getByRole('button', { name: '登记，下一步', exact: true }).click()
    await expect(page.getByRole('heading', { name: '给您的馆起个名', exact: true })).toBeVisible()
    await page.getByLabel('馆名', { exact: true }).fill('合成养生馆')
    await page.getByLabel('一句介绍', { exact: true }).fill('一起照顾日常作息，慢慢练成适合自己的习惯。')
    await page.getByRole('button', { name: /暖白/ }).click()
    await expect(page.getByText('合成阿慈老师邀请你', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '就用这个名字', exact: true }).click()
    await expect(page.getByText('✓ 模型已接好', { exact: true })).toBeVisible()
    for (const label of ['模板', '排班', '邀约方式', '药材库', '保留期限', '模型']) {
      await page.getByRole('button', { name: '就这样，保存' + label, exact: true }).click()
    }
    await page.getByRole('button', { name: '开馆', exact: true }).click()
    await expect(page.getByRole('heading', { name: '请第一位学生进来', exact: true })).toBeVisible()
    await page.locator('details.op-link-details > summary').click()
    const invite = await page.getByLabel('邀请链接', { exact: true }).inputValue()
    expect(invite).toContain('invite=')
    await page.getByRole('button', { name: '先进去看看', exact: true }).click()
    await expect(page.getByRole('heading', { name: '已进入老师首页', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // 06 学生名单 → 07 一位学生 → 开始面诊直接进 V2-16 的面诊页
  {
    const { context, page, errors } = await open('students')
    await page.getByRole('button', { name: '学生', exact: true }).click()
    await expect(page.getByRole('heading', { name: '学生', exact: true })).toBeVisible()
    await expect(page.getByText('5 位', { exact: true })).toBeVisible()
    const rows = page.locator('.ts-row')
    expect(await rows.count()).toBe(5)
    await expect(page.getByText('本周 5/7', { exact: true })).toBeVisible()
    await expect(page.getByText('本周还没打卡', { exact: true })).toBeVisible()
    await expect(page.getByText(/由小林代管/)).toBeVisible()
    await layout(page)
    await shot(page, 'phone-teacher-students')
    await page.getByLabel('找一位学生', { exact: true }).fill('小陈')
    expect(await page.locator('.ts-row').count()).toBe(1)
    await page.getByLabel('找一位学生', { exact: true }).fill('')
    await page.getByRole('button', { name: /最近来过/ }).click()
    expect(await page.locator('.ts-row').count()).toBeGreaterThan(0)
    await page.getByRole('button', { name: /全部/ }).click()
    await page.locator('.ts-row').filter({ hasText: '小王' }).click()
    await expect(page.getByRole('heading', { name: '小王', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '当前方案' })).toContainText('老师已签字')
    await expect(page.getByRole('region', { name: '坚持情况' })).toContainText('本周完成 5 天')
    await expect(page.getByRole('region', { name: '坚持情况' })).toContainText('本周完成 5 天')
    await expect(page.getByRole('region', { name: '历次病历' })).toContainText('全部 3 次')
    await expect(page.getByRole('region', { name: '钱账' })).toContainText('120.00')
    await layout(page)
    await shot(page, 'phone-teacher-student')
    await page.getByRole('button', { name: '＋ 开始面诊', exact: true }).click()
    await expect(page.getByLabel('您说，智能体记', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '小王', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // 08 我的馆：馆卡片、邀请主按钮、门面、钱账总览、设置入口
  {
    const { context, page, errors } = await open('hall')
    await page.getByRole('button', { name: '我的馆', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的馆', exact: true })).toBeVisible()
    await expect(page.getByText('已开馆', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '＋ 邀请学生', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /门面/ })).toBeVisible()
    await expect(page.getByRole('region', { name: '钱账总览' })).toContainText('1,120.00')
    await expect(page.getByRole('region', { name: '钱账总览' })).toContainText('本月确认收款')
    await page.evaluate(() => window.dispatchEvent(new Event('aster:data-changed')))
    await layout(page)
    await shot(page, 'phone-teacher-hall')
    await page.locator('.hall-row').filter({ hasText: '设置' }).click()
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
    for (const label of ['记录保留多久', '换手机', '向社区分享运行统计', '我的镜子']) await expect(page.getByRole('button', { name: new RegExp(label) })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // 09 学生进馆首屏
  {
    const { context, page, errors } = await open('welcome')
    await expect(page.getByRole('heading', { name: '合成养生馆', exact: true })).toBeVisible()
    await expect(page.getByText('合成阿慈老师邀请你', { exact: true })).toBeVisible()
    await expect(page.getByText(/每天照照镜子/)).toBeVisible()
    await expect(page.getByRole('button', { name: '开始使用', exact: true })).toBeVisible()
    await expect(page.getByText('接下来，接入你自己的模型。', { exact: true })).toBeVisible()
    await layout(page)
    await shot(page, 'phone-student-welcome')
    expect(errors).toEqual([])
    await context.close()
  }
  // V2-23 新学生：必填基础信息不全时，点“告诉老师”先进基础信息页；填全保存后直接进问诊
  {
    const { context, page, errors } = await open('newstudent')
    // 发起人：出生日期等是进馆时的必填项 → 新学生进馆第一屏就是基础信息，没有返回键。
    await expect(page.getByRole('heading', { name: '进馆：先填基础信息', exact: true })).toBeVisible()
    await expect(page.getByText('老师邀请您进馆。这是一件健康工具，请认真填好下面的基础信息，填完就能开始用了。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '返回', exact: true })).toHaveCount(0)
    await expect(page.getByText('还差：性别、出生日期', { exact: true })).toHaveCount(0)
    await layout(page)
    await shot(page, 'phone-student-basics')
    // iPhone 15 Pro 与华为 Mate 40 Pro 宽度各一张
    for (const [width, height, name] of [[393, 852, 'phone-student-basics-iphone15pro'], [448, 924, 'phone-student-basics-huawei-448']]) {
      await page.setViewportSize({ width, height })
      await layout(page)
      await shot(page, name)
    }
    await page.setViewportSize({ width: 375, height: 812 })
    // 称呼和居住城市沿用以前填过的（“我的时间”里的城市），不用重填。
    await expect(page.getByLabel('称呼', { exact: true })).toHaveValue('合成小王')
    await expect(page.getByLabel('居住城市', { exact: true })).toHaveValue('北京市')
    await page.getByLabel('男', { exact: true }).check()
    await page.getByLabel('出生时辰', { exact: true }).selectOption('午')
    await page.getByLabel('出生地', { exact: true }).selectOption('上海市')
    for (const label of ['既往病史', '在用药', '过敏']) await page.getByLabel(label, { exact: true }).fill('无')
    await page.getByLabel('平时几点起', { exact: true }).fill('07:00')
    await page.getByLabel('平时几点睡', { exact: true }).fill('23:00')
    await page.getByLabel('出生日期', { exact: true }).fill('2099-01-01')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('出生日期不能晚于今天')
    await page.getByLabel('出生日期', { exact: true }).fill('1992-03-04')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    // 填好后进首页，不再出现“还差”提示；问诊直接可用。
    await expect(page.locator('[data-page=student-today]')).toBeVisible()
    await expect(page.locator('.basics-banner')).toHaveCount(0)
    await page.getByRole('button', { name: /不舒服？告诉/ }).click()
    await expect(page.getByRole('heading', { name: /^告诉/ })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // 10a–10c 问诊三步：说一说 → 再问一句（可跳过）→ 看一眼卡片再发出
  {
    const { context, page, errors } = await open('consult')
    await page.getByRole('button', { name: /不舒服？告诉/ }).click()
    await expect(page.getByRole('heading', { name: /^告诉/ })).toBeVisible()
    await expect(page.getByLabel('按键盘上的🎤说话就行', { exact: true })).toBeVisible()
    await expect(page.getByText(FIRST_AID, { exact: true })).toBeVisible()
    await layout(page)
    await shot(page, 'phone-student-consult-speak')
    await page.getByLabel('按键盘上的🎤说话就行', { exact: true }).fill('最近睡不好，夜里容易醒')
    await page.getByRole('button', { name: '说好了，继续', exact: true }).click()
    await expect(page.getByRole('heading', { name: '再问一句', exact: true })).toBeVisible()
    await expect(page.getByLabel('补充一下', { exact: true })).toBeVisible()
    await expect(page.getByText(FIRST_AID, { exact: true })).toBeVisible()
    await layout(page)
    await shot(page, 'phone-student-consult-followup')
    await page.getByLabel('补充一下', { exact: true }).fill('白天也没精神，容易心慌')
    await page.getByRole('button', { name: '补充好了，整理卡片', exact: true }).click()
    await skipToCard(page)
    await expect(page.getByText('草稿 · 待你核对', { exact: true })).toBeVisible()
    await expect(page.getByText(FIRST_AID, { exact: true })).toBeVisible()
    for (const label of ['主诉', '现病史', '既往史', '在用药']) await expect(page.locator('.cf-field dt').filter({ hasText: label })).toBeVisible()
    await expect(page.locator('.cf-field').filter({ hasText: '主诉' })).toContainText('最近睡不好')
    await expect(page.locator('.cf-field').filter({ hasText: '现病史' })).toContainText('白天也没精神')
    await expect(page.getByRole('region', { name: '这次的舌象' })).toBeVisible()
    await layout(page)
    await shot(page, 'phone-student-consult-card')
    await page.getByRole('button', { name: /^发给/ }).click()
    await expect(page.getByRole('heading', { name: '已发给老师', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // 10d 急症：顶部那句常驻提示，不弹窗、不拦截、无电话号码，仍能发出
  {
    const { context, page, errors } = await open('consult')
    await page.getByRole('button', { name: /不舒服？告诉/ }).click()
    await expect(page.getByText(FIRST_AID, { exact: true })).toBeVisible()
    await page.getByLabel('按键盘上的🎤说话就行', { exact: true }).fill('胸口闷，还一直冒冷汗')
    await page.getByRole('button', { name: '说好了，继续', exact: true }).click()
    await skipToCard(page)
    await expect(page.getByText(FIRST_AID, { exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expectNoPhoneNumbers(page)
    const send = page.getByRole('button', { name: /^发给/ })
    await expect(send).toBeEnabled()
    await layout(page)
    await shot(page, 'phone-student-consult-emergency')
    await send.click()
    await expect(page.getByRole('heading', { name: '已发给老师', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // 说自伤/轻生的话：和平常一样，只有顶端那句常驻提示，照常能发出，没有任何电话号码
  {
    const { context, page, errors } = await open('consult')
    await page.getByRole('button', { name: /不舒服？告诉/ }).click()
    await expect(page.getByText(FIRST_AID, { exact: true })).toBeVisible()
    await page.getByLabel('按键盘上的🎤说话就行', { exact: true }).fill('心里难受、不想活')
    await page.getByRole('button', { name: '说好了，继续', exact: true }).click()
    await skipToCard(page)
    await expect(page.getByText(FIRST_AID, { exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expectNoPhoneNumbers(page)
    const send = page.getByRole('button', { name: /^发给/ })
    await expect(send).toBeEnabled()
    await send.click()
    await expect(page.getByRole('heading', { name: '已发给老师', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // 11 记录：我的病历、舌象的变化、坚持的趋势
  {
    const { context, page, errors } = await open('records')
    await page.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '记录', exact: true }).click()
    await expect(page.getByRole('heading', { name: '记录', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '我的病历' })).toContainText('全部 2 次')
    await expect(page.getByRole('region', { name: '舌象的变化' })).toBeVisible()
    expect(await page.locator('.rc-tongue').count()).toBe(3)
    await expect(page.getByRole('region', { name: '坚持的趋势' })).toContainText('近四周')
    await expect(page.locator('.rc-trend svg')).toBeVisible()
    await layout(page)
    await shot(page, 'phone-student-records')
    await expect(errors).toEqual([])
    await context.close()
  }
  // 12 我：我的老师、家人、余额、设置
  {
    const { context, page, errors } = await open('me')
    await page.getByRole('navigation', { name: '学生底部标签' }).getByRole('button', { name: '我', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '我的老师' })).toContainText('合成养生馆')
    await expect(page.getByRole('region', { name: '我的老师' })).toContainText('当前馆')
    await expect(page.getByRole('region', { name: '家人' })).toContainText('妈妈 · 李阿姨')
    await expect(page.getByRole('region', { name: '在老师这里的余额' })).toContainText('120.00')
    await layout(page)
    await shot(page, 'phone-student-me')
    await page.getByRole('button', { name: /^设置/ }).click()
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
    await expect(page.getByText('模型、我的时间、通知', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  // ---- V2-16 回归：今天/面诊/核对签字/学生首页/长病历/舌象/仪表盘 ----
  {
    const { context, page, errors } = await open('today')
    await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '学生到了？', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '等您签字', exact: true })).toBeVisible()
    await expect(page.getByText('合成小王 这周只练了 2 天', { exact: true })).toBeVisible()
    await layout(page)
    await page.getByRole('button', { name: /合成小王/ }).click()
    await expect(page.getByRole('heading', { name: /· 核对$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: '签字发出', exact: true })).toBeDisabled()
    for (let guard = 0; guard < 12; guard += 1) {
      const draft = page.locator('.nl-review-block.draft').first()
      if (await draft.count() === 0) break
      await draft.getByRole('button', { name: '就这样', exact: true }).first().click()
    }
    await page.getByRole('button', { name: '签字发出', exact: true }).click()
    await expect(page.getByRole('heading', { name: '已签字交还', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  }
  {
    const { context, page, errors } = await open('visit')
    await page.getByRole('button', { name: /开始面诊/ }).click()
    await page.getByRole('button', { name: /学生 1/ }).click()
    await expect(page.getByLabel('您说，智能体记', { exact: true })).toBeVisible()
    await page.getByLabel('您说，智能体记', { exact: true }).fill('舌淡红，苔薄白；入睡难；脉细弱')
    await page.getByRole('button', { name: '整理', exact: true }).click()
    await expect(page.getByRole('button', { name: '四诊 look' })).toContainText('舌淡红，苔薄白')
    await page.getByRole('button', { name: '说完了，看草稿', exact: true }).click()
    await expect(page.getByRole('heading', { name: /· 核对$/ })).toBeVisible()
    await layout(page)
    expect(errors).toEqual([])
    await context.close()
  }
  {
    const { context, page, errors } = await open('student')
    await expect(page.getByRole('heading', { name: /早上好|中午好|下午好|晚上好|夜深了/ })).toBeVisible()
    await expect(page.getByRole('region', { name: '天时与今日调养' })).toContainText('霜降养脾胃')
    await expect(page.getByRole('region', { name: '今日作业' })).toContainText('泡脚十五分钟')
    await layout(page)
    const circle = page.getByRole('button', { name: '打卡：泡脚十五分钟', exact: true })
    await expect(circle).toHaveAttribute('aria-pressed', 'false')
    await circle.click()
    await expect(circle).toHaveAttribute('aria-pressed', 'true')
    expect(errors).toEqual([])
    await context.close()
  }
  {
    const { context, page, errors } = await open('long')
    await expect(page.locator('[data-long-record="yes"]')).toBeVisible()
    expect(await page.locator('details.nl-review-block').count()).toBe(3)
    expect(errors).toEqual([])
    await context.close()
  }
  {
    const { context, page, errors } = await open('tongue')
    await expect(page.getByRole('group', { name: '对照方式' })).toBeVisible()
    await layout(page)
    expect(errors).toEqual([])
    await context.close()
  }
  {
    const { context, page, errors } = await open('dashboard')
    await expect(page.getByRole('heading', { name: '社区仪表盘', exact: true })).toBeVisible()
    expect(await page.locator('button, input, select, textarea, a, form').count()).toBe(0)
    expect(errors).toEqual([])
    await context.close()
  }
  console.log('PASS: V2-17 新界面 375px 建馆五步/学生名单/一位学生/我的馆/进馆首屏/问诊三步/急症不拦截/记录/我 + V2-16 回归')
} finally { await browser.close(); await server.close() }
