import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { actors } from './actors.mjs'
export const runtime = JSON.parse(readFileSync(process.env.E2E_RUNTIME_FILE!, 'utf8'))
type Person = { context: BrowserContext; page: Page; actor: typeof actors.teacher }
export const test = base.extend<{ people: { teacher: Person; student: Person } }>({
  people: async ({ browser, baseURL }, use) => {
    const teacherContext = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL })
    const studentContext = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL })
    try {
      const teacher = { context: teacherContext, page: await teacherContext.newPage(), actor: actors.teacher }
      const student = { context: studentContext, page: await studentContext.newPage(), actor: actors.student }
      for (const person of [teacher, student]) {
        await person.page.goto('/')
        await person.page.getByRole('button', { name: '使用助记词恢复' }).click()
        await person.page.getByRole('textbox', { name: /输入 12 个词/ }).fill(person.actor.phrase)
        await person.page.getByRole('button', { name: '校验并恢复' }).click()
        await expect(person.page.getByRole('heading', { name: '身份已就绪' })).toBeVisible()
      }
      await use({ teacher, student })
    } finally { await teacherContext.close(); await studentContext.close() }
  },
})
export { expect }
