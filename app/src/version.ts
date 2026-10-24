// V2-29：版本号由 Vite 在构建时注入（见 app/vite.config.ts 的 define），页面运行时不调用 git。
declare const __APP_VERSION__: string

export function appVersion(): string {
  const injected = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.trim() : ''
  return injected === '' ? '开发版' : injected
}
