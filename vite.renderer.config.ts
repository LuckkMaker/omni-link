import { resolve } from 'path'
import { readFileSync } from 'fs'
import react from '@vitejs/plugin-react'

// 浏览器模式独立启动渲染进程 dev server（不启动 Electron）。
// 后端地址由 src/services/api.ts 在无 Electron 时回退到 127.0.0.1:8765。
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default {
  root: resolve(__dirname, 'src'),
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [react()],
}