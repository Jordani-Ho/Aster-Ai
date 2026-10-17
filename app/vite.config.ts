import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['lunar-typescript'] },
  server: { fs: { allow: ['..'] } },
  test: { environment: 'node' },
})
