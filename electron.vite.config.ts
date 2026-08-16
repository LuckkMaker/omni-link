import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 构建期读取 package.json 版本号，注入到 renderer 全局变量 __APP_VERSION__
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    optimizeDeps: {
      // monaco-editor 的 `?worker` 导入需按源码处理，否则预打包阶段无法解析 worker 后缀
      exclude: ['monaco-editor']
    },
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
