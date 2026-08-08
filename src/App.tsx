import { Routes, Route, Navigate } from 'react-router-dom'
import MainLayout from './layouts/MainLayout'
import FlashPage from './pages/flash'
import RttPage from './pages/rtt'
import MonitorPage from './pages/monitor'
import ZonePage from './pages/zone'
import SettingsPage from './pages/settings'
import ToolsLayout from './pages/tools'
import FaultAnalyzer from './pages/tools/fault-analyzer'
import MapAnalyzer from './pages/tools/map-analyzer'
import NumberConverter from './pages/tools/number-converter'
import FileChecksum from './pages/tools/file-checksum'

export default function App() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/" element={<Navigate to="/flash" replace />} />
        <Route path="/flash" element={<FlashPage />} />
        {/* Commander 页面由 MainLayout 通过 keep-alive 常驻渲染。
            此占位路由让父布局能匹配 /commander 路径（element 为 null，Outlet 渲染空），
            实际内容由 MainLayout 内的 CommanderPage 承载。 */}
        <Route path="/commander" element={null} />
        <Route path="/rtt" element={<RttPage />} />
        <Route path="/monitor" element={<MonitorPage />} />
        <Route path="/zone" element={<ZonePage />} />
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
  )
}
