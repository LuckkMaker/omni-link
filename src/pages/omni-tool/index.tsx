import { Navigate } from 'react-router-dom'
import { DEFAULT_SECTION } from './sections'

/**
 * `/omni-tool` 重定向到默认子页面。
 *
 * 子页面路由：
 * - `/omni-tool/boot`     给工具自身刷固件
 * - `/omni-tool/flasher`  在线烧录外部目标
 */
export default function OmniToolIndexPage() {
  return <Navigate to={`/omni-tool/${DEFAULT_SECTION}`} replace />
}