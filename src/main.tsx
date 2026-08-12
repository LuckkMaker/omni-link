// OMNI Link
// Copyright (c) 2026 LuckkMaker
// SPDX-License-Identifier: MIT

import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { Toaster } from '@/components/ui/sonner'
import './styles/globals.css'

// 运行时设置窗口标题（含应用版本号）。
// __APP_VERSION__ 由 electron.vite.config.ts 构建期注入，来自 package.json version。
// 开表态（vite dev）和打包态（electron）都生效，避免 index.html 静态标题与版本不同步。
document.title = `OMNI Link v${__APP_VERSION__}`

// 注意：不使用 React.StrictMode。
// @monaco-editor/react 的 Editor 组件与 StrictMode 的 mount→unmount→mount 不兼容：
// 首次 mount 创建 Monaco 实例后，StrictMode 模拟的 unmount 会 dispose 该实例，
// 但组件状态未重置，重新 mount 后仍引用已 dispose 的实例，导致
// "InstantiationService has been disposed" 崩溃。移除 StrictMode 使 dev/prod 行为一致。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <App />
    <Toaster />
  </HashRouter>
)
