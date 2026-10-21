# PWA 静态文件

sw.js 只处理固定新消息通知及点击打开，不缓存应用或业务数据。manifest.webmanifest 提供主屏幕安装信息：icon-192.png / icon-512.png 给 Android，apple-touch-icon.png 给 iOS；icon.svg 是源图。图标由 `scripts/generate-pwa-icons.mjs` 用现有 Playwright 生成，不新增依赖。
