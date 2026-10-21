import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// V2-13：用现有 Playwright（根 devDependency）把 icon.svg 生成主屏幕用 PNG，不新增依赖。
// 真机安装：Android 用 manifest 的 192/512，iOS 用 apple-touch-icon。
const root = fileURLToPath(new URL('../', import.meta.url))
const svg = readFileSync(root + 'app/public/icon.svg', 'utf8')
const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
const icons = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
]
const browser = await chromium.launch({ headless: true })
try {
  for (const icon of icons) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } })
    await page.setContent(`<style>html,body{margin:0;background:#183e35}img{display:block;width:${icon.size}px;height:${icon.size}px}</style><img src="${dataUrl}" width="${icon.size}" height="${icon.size}" alt="">`)
    await page.screenshot({ path: root + 'app/public/' + icon.file, clip: { x: 0, y: 0, width: icon.size, height: icon.size } })
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('PWA icons: ' + icons.map(icon => icon.file + ' ' + icon.size + '×' + icon.size).join(', '))
