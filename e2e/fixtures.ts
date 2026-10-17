import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { actors } from './actors.mjs'
export const runtime = JSON.parse(readFileSync(process.env.E2E_RUNTIME_FILE!, 'utf8'))
type Person = { context: BrowserContext; page: Page; actor: typeof actors.teacher }
export const test = base.extend<{ people: { teacher: Person; student: Person }; seedLedger: boolean }>({
  seedLedger: [false, { option: true }],
  people: async ({ browser, baseURL, request, seedLedger }, use) => {
    const reset = await request.post(runtime.controlURL + '/reset', { headers: { authorization: 'Bearer ' + runtime.resetToken } })
    expect(reset.status()).toBe(200)
    const teacherContext = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL })
    const studentContext = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL })
    try {
      const teacher = { context: teacherContext, page: await teacherContext.newPage(), actor: actors.teacher }
      const student = { context: studentContext, page: await studentContext.newPage(), actor: actors.student }
      for (const person of [teacher, student]) {
        await person.page.goto('/')
        await expect(person.page.getByRole('button', { name: '使用助记词恢复' })).toBeVisible()
        if (seedLedger) await person.page.evaluate(async ({ phrase, teacher, student }) => {
          const identityPath='/src/core/identity/index.ts', storePath='/src/core/store/index.ts', syncPath='/src/core/ledger/sync.ts'
          const { restoreIdentity }=await import(identityPath), { openStore }=await import(storePath), { createLedgerSync }=await import(syncPath)
          const identity=restoreIdentity(phrase), store=await openStore(identity)
          const sync=createLedgerSync({identity,store,send:async()=>{throw Error('fixture transport starts after UI restore')}})
          try { await sync.open(teacher,student); if(identity.publicKey===teacher)await sync.record(teacher,student,{type:'topup',amount:10}) }
          finally { await sync.close();store.close() }
        }, { phrase: person.actor.phrase, teacher: actors.teacher.pubkey, student: actors.student.pubkey })
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
