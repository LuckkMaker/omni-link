// OMNI Link
// Copyright (c) 2026 LuckkMaker
// SPDX-License-Identifier: MIT

import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import { Toaster } from '@/components/ui/sonner'
import './styles/globals.css'

// 运行时设置窗口标题（含应用版本号）。
// __APP_VERSION__ 由 electron.vite.config.ts 构建期注入，来自 package.json version。
// 开表态（vite dev）和打包态（electron）都生效，避免 index.html 静态标题与版本不同步。
document.title = `OMNI Link v${__APP_VERSION__}`

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
      <Toaster />
    </HashRouter>
  </React.StrictMode>
)
