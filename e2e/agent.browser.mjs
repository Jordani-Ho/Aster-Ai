import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const server = await createServer({ configFile: root + 'app/vite.config.ts', root: root + 'app', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext(), errors = []
  await context.route('**/agent-probe.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Synthetic agent probe</title>' }))
  const pages = [await context.newPage(), await context.newPage()]
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/agent-probe.html`)
    await page.evaluate(async first => {
      const paths = ['/src/core/agent/runner.ts', '/src/core/agent/tasks.ts', '/src/core/store/index.ts', '/src/core/identity/index.ts']
      const [engine, tasks, stores, identities] = await Promise.all(paths.map(p => import(p)))
      const store = first ? await stores.openStore(identities.createIdentity()) : (await stores.resumeStore()).store
      const recipient = 'a'.repeat(64), now = new Date(2026, 9, 24, 9)
      await store.put('teacher-students', recipient, { student: recipient })
      const count = { gather: 0, run: 0, sent: 0 }
      const runner = engine.createRunner({ store, side: 'teacher', maxTokens: 100, send: async () => { count.sent++ } })
      const task = tasks.defineTask({
        id: 'synthetic', side: 'teacher', trigger: { kind: 'manual' }, confirm: 'human',
        gather: async () => { count.gather++; return { value: 'SYNTHETIC_ONLY' } },
        run: async data => { count.run++; await new Promise(resolve => setTimeout(resolve, 100)); return data },
        deliver: async (output, delivery) => delivery.send(recipient, output),
      })
      window.agentProbe = { run: () => runner.run(task, { targetId: recipient, now }), confirm: () => runner.confirm(task, { targetId: recipient, now }), inspect: () => count, close: () => store.close() }
    }, index === 0)
  }
  const results = await Promise.all(pages.map(page => page.evaluate(() => window.agentProbe.run())))
  expect(results[0]).toEqual(results[1]); expect(results[0].status).toBe('draft')
  let counts = await Promise.all(pages.map(page => page.evaluate(() => window.agentProbe.inspect())))
  expect(counts.reduce((sum, row) => sum + row.run, 0)).toBe(1)
  expect(counts.reduce((sum, row) => sum + row.sent, 0)).toBe(0)
  await Promise.all(pages.map(page => page.evaluate(() => window.agentProbe.confirm())))
  counts = await Promise.all(pages.map(page => page.evaluate(() => window.agentProbe.inspect())))
  expect(counts.reduce((sum, row) => sum + row.sent, 0)).toBe(1)
  for (const page of pages) await page.evaluate(() => window.agentProbe.close())
  expect(errors).toEqual([])
  console.log('PASS V2-21: real Chromium + IndexedDB + cross-tab Web Locks; one gather/run, human confirmation before sending, one delivery; synthetic data only.')
} finally { await browser.close(); await server.close() }
