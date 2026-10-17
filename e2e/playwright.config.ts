import { defineConfig } from '@playwright/test'
import { readFileSync } from 'node:fs'
if (!process.env.E2E_RUNTIME_FILE) throw Error('Use npm run e2e; direct Playwright execution has no managed environment')
const runtime = JSON.parse(readFileSync(process.env.E2E_RUNTIME_FILE, 'utf8'))
export default defineConfig({
  testDir: '.', testMatch: '**/*.spec.ts', fullyParallel: false, workers: 1, retries: 0, forbidOnly: !!process.env.CI,
  timeout: 60000, expect: { timeout: 15000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: { baseURL: runtime.baseURL, browserName: 'chromium', viewport: { width: 375, height: 812 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off' },
})
