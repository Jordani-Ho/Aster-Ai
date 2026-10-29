import { chromium, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { root } from './process.mjs'
import { startGatewayFixture } from './gateway-fixture.mjs'
import { startWebApp } from './environment.mjs'

// V2-42：内测专用的「清空这台设备上的知衡」。
// 1) 内测开关关：页面上没有这个按钮；2) 开关开：必须输入「清空」才执行，执行后回到第一次打开；
// 3) 老师端「我的馆 → 设置」里也有同一个按钮（学生端用的是同一个组件，源码里断言它在 StudentMe 的设置里）。
const appSource = await readFile(path.join(root, 'app/src/App.tsx'), 'utf8')
const studentSource = await readFile(path.join(root, 'app/src/StudentMe.tsx'), 'utf8')
for (const [name, source] of [['App.tsx（老师端设置）', appSource], ['StudentMe.tsx（学生端设置）', studentSource]]) {
  if (!/<PilotReset\s*\/>/.test(source)) throw Error(name + ' 没有接入 PilotReset')
}

const cache = path.join(root, '.cache/e2e')
await mkdir(cache, { recursive: true })
const directory = await mkdtemp(path.join(cache, 'v242-'))
let gateway, appOff, appOn, browser
try {
  gateway = await startGatewayFixture({ directory, members: [] })
  browser = await chromium.launch({ headless: true })

  // 内测开关关闭：没有按钮。
  appOff = await startWebApp({ gatewayUrl: gateway.url, relayUrl: 'ws://127.0.0.1:1/' })
  const off = await browser.newPage()
  await off.goto(appOff.url)
  await expect(off.getByRole('heading', { name: '您是老师还是学生？' })).toBeVisible()
  await off.getByText('设置', { exact: true }).click()
  await expect(off.getByText('清空这台设备上的知衡')).toHaveCount(0)
  await off.close()

  // 内测开关打开：按钮 → 先讲清后果 → 输入「清空」才执行 → 回到第一次打开。
  appOn = await startWebApp({ gatewayUrl: gateway.url, relayUrl: 'ws://127.0.0.1:1/', pilotMode: true })
  const on = await browser.newPage()
  await on.goto(appOn.url)
  await expect(on.getByRole('heading', { name: '您是老师还是学生？' })).toBeVisible()
  await on.evaluate(async () => {
    const { resumeStore } = await import('/src/core/store/index.ts')
    const session = await resumeStore()
    try { await session.store.put('settings', 'v242-marker', { at: 1 }) } finally { session.store.close() }
  })
  await on.getByText('设置', { exact: true }).click()
  await on.getByText('内测：清空这台设备', { exact: true }).first().click()
  await on.getByText('清空这台设备上的知衡').click()
  await expect(on.getByText('会删掉这台设备上知衡的全部资料（身份、病历、照片、设置），删了找不回。')).toBeVisible()
  await on.getByRole('button', { name: '确认清空', exact: true }).click()
  await expect(on.getByRole('alert')).toContainText('要输入「清空」两个字')
  await on.getByLabel('输入「清空」两个字').fill('清空')
  await on.getByRole('button', { name: '确认清空', exact: true }).click()
  await expect(on.getByRole('heading', { name: '您是老师还是学生？' })).toBeVisible({ timeout: 20000 })
  const after = await on.evaluate(async () => {
    const open = () => new Promise((resolve, reject) => { const request = indexedDB.open('aster-local-store', 1); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result) })
    const db = await open()
    const rows = await new Promise((resolve, reject) => { const tx = db.transaction(['records'], 'readonly'); const request = tx.objectStore('records').getAll(); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result) })
    db.close()
    return { marker: rows.some(row => row.c === 'settings' && row.k === 'v242-marker'), total: rows.length }
  })
  expect(after.marker).toBe(false)

  // 老师端：开馆后「我的馆 → 设置」里有同一个按钮。
  const teacher = await browser.newPage()
  await teacher.goto(appOn.url)
  await expect(teacher.getByRole('heading', { name: '您是老师还是学生？' })).toBeVisible()
  await teacher.evaluate(async () => {
    const { resumeStore } = await import('/src/core/store/index.ts')
    const { onboardingRequest } = await import('/src/core/onboarding/index.ts')
    const { completeHall } = await import('/src/core/hall/index.ts')
    const session = await resumeStore()
    try {
      await onboardingRequest(session.identity, location.origin + '/invite/seed', { token: 'SYNTHETIC_DEPLOYMENT_TOKEN' })
      await completeHall(session.store)
      await session.store.put('settings', 'role', { role: 'teacher' })
    } finally { session.store.close(); session.identity.privateKey.fill(0) }
  })
  await teacher.reload()
  await expect(teacher.getByRole('heading', { name: '今天', exact: true })).toBeVisible()
  await teacher.getByRole('button', { name: '我的馆', exact: true }).click()
  await teacher.locator('.hall-row').filter({ hasText: '设置' }).click()
  await expect(teacher.getByText('内测：清空这台设备', { exact: true })).toHaveCount(1)
  console.log('V2-42 清空按钮：开关关时不出现、开时需输入「清空」、清空后回到首次打开；老师设置里也有，通过')
} finally {
  await browser?.close().catch(() => {})
  await appOff?.close().catch(() => {})
  await appOn?.close().catch(() => {})
  await gateway?.close().catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
