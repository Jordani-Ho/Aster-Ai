import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// V2-13：老师和学生都要能“添加到主屏幕”。图标用现有静态资源，不新增依赖。
const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
const appDir = fileURLToPath(new URL('../', import.meta.url))

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file)
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('PWA 主屏幕安装素材', () => {
  const manifest = JSON.parse(readFileSync(publicDir + 'manifest.webmanifest', 'utf8')) as {
    name: string; short_name: string; display: string; start_url: string
    icons: { src: string; sizes: string; type: string; purpose?: string }[]
  }
  const html = readFileSync(appDir + 'index.html', 'utf8')

  it('manifest 有 192/512 PNG 图标和 standalone 启动', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    const png = manifest.icons.filter(icon => icon.type === 'image/png')
    expect(png.some(icon => icon.sizes === '192x192' && icon.src === '/icon-192.png')).toBe(true)
    expect(png.some(icon => icon.sizes === '512x512' && icon.src === '/icon-512.png')).toBe(true)
  })

  it('PNG 图标文件真实存在且尺寸正确', () => {
    expect(pngSize(publicDir + 'icon-192.png')).toEqual({ width: 192, height: 192 })
    expect(pngSize(publicDir + 'icon-512.png')).toEqual({ width: 512, height: 512 })
    expect(pngSize(publicDir + 'apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
    for (const file of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) expect(statSync(publicDir + file).size).toBeGreaterThan(0)
  })

  it('index.html 引用 manifest 与 apple-touch-icon', () => {
    expect(html).toContain('rel="manifest"')
    expect(html).toContain('rel="apple-touch-icon"')
    expect(html).toContain('/apple-touch-icon.png')
    expect(html).toContain('apple-mobile-web-app-capable')
  })
})
