import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// 渲染进程纯逻辑测试（不启动 Electron / 后端）。
// 组件与 store 里用的是 `@/`、`@shared/` 别名，这里与 tsconfig 保持同一套映射。
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
