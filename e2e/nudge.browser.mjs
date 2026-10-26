import { chromium, expect } from '@playwright/test'
import { createServer } from '../app/node_modules/vite/dist/node/index.js'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/')
const server = await createServer({ configFile: root + 'app/vite.config.ts', root: root + 'app', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext(), page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/nudge-probe.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Synthetic nudge probe</title>' }))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/nudge-probe.html`)
  const first = await page.evaluate(async () => {
    const storePath = '/src/core/store/index.ts', identityPath = '/src/core/identity/index.ts', nudgePath = '/src/core/nudge/index.ts'
    const { openStore } = await import(storePath), { createIdentity } = await import(identityPath), { runStudentNudges, listNudges } = await import(nudgePath)
    const identity = createIdentity(), store = await openStore(identity)
    await store.put('homework', 'synthetic-stretch', {
      homework: { id: 'synthetic-stretch', title: '伸展练习', detail: '合成测试', source: 'teacher', schedule: { kind: 'daily', time: '08:00' } },
      startsOn: '2026-10-24',
    })
    await store.put('settings', 'agent-routine', { wake: '07:00', sleep: '23:00' })
    const now = new Date(2026, 9, 25, 8, 11)
    await runStudentNudges({ store, settingsStore: store, identity, teacher: null, now })
    await runStudentNudges({ store, settingsStore: store, identity, teacher: null, now })
    const before = await listNudges(store)
    await store.put('checkins', 'synthetic-check', { homeworkId: 'synthetic-stretch', at: new Date(2026, 9, 25, 8, 12).toISOString() })
    await runStudentNudges({ store, settingsStore: store, identity, teacher: null, now: new Date(2026, 9, 25, 8, 13) })
    const after = await listNudges(store)
    const runs = await store.list('agent-runs')
    store.close()
    return { before, after, runs: runs.length }
  })
  expect(first.before).toHaveLength(1)
  expect(first.before[0].text).toContain('伸展练习')
  expect(first.before[0].actedAt).toBeNull()
  expect(first.after).toHaveLength(1)
  expect(first.after[0].actedAt).not.toBeNull()
  expect(first.runs).toBe(0)
  expect(errors).toEqual([])
  console.log('PASS V2-27: real Chromium + IndexedDB; fixed nudge once, real check-in reconciled locally, no retained agent run; synthetic data only.')
} finally { await browser.close(); await server.close() }
