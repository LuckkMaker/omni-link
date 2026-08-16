import { Component, type ReactNode } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import MainLayout from './layouts/MainLayout'
import FlashPage from './pages/flash'
import RttPage from './pages/rtt'
import MonitorPage from './pages/monitor'
import SettingsPage from './pages/settings'
import ToolsLayout from './pages/tools'
import FaultAnalyzer from './pages/tools/fault-analyzer'
import MapAnalyzer from './pages/tools/map-analyzer'
import NumberConverter from './pages/tools/number-converter'
import FileChecksum from './pages/tools/file-checksum'

/** 临时错误边界：捕获渲染错误并显示，避免白屏无法诊断（定位后移除） */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: unknown) {
    console.error('[ErrorBoundary]', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
          <h2 style={{ color: '#c0392b' }}>渲染错误</h2>
          <pre>{this.state.error.stack ?? String(this.state.error)}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<Navigate to="/zone" replace />} />
          <Route path="/flash" element={<FlashPage />} />
          {/* Commander 页面由 MainLayout 通过 keep-alive 常驻渲染。
              此占位路由让父布局能匹配 /commander 路径（element 为 null，Outlet 渲染空），
              实际内容由 MainLayout 内的 CommanderPage 承载。 */}
          <Route path="/commander" element={null} />
          <Route path="/rtt" element={<RttPage />} />
          <Route path="/monitor" element={<MonitorPage />} />
          {/* Zone 页面由 MainLayout 通过 keep-alive 常驻渲染（切换页面不丢失内容与 UI 状态）。
              此占位路由让父布局能匹配 /zone 路径（element 为 null，Outlet 渲染空），
              实际内容由 MainLayout 内的 ZonePage 承载。 */}
          <Route path="/zone" element={null} />
          <Route path="/tools" element={<ToolsLayout />}>
            <Route index element={<Navigate to="/tools/fault" replace />} />
            <Route path="fault" element={<FaultAnalyzer />} />
            <Route path="map" element={<MapAnalyzer />} />
            <Route path="number" element={<NumberConverter />} />
            <Route path="checksum" element={<FileChecksum />} />
          </Route>
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </ErrorBoundary>
  )
}
