import { Outlet } from 'react-router-dom'

/**
 * OMNI Tool 布局：只承载子功能 Outlet。
 *
 * 子页面：
 * - `/omni-tool/boot`     给工具自身刷固件（原 OmniToolPage 内容）
 * - `/omni-tool/flasher`  把工具当探针，在线烧录外部目标
 *
 * 子功能列表集中在 `sections.ts`，与侧边栏二级菜单共用，避免两处入口漂移。
 */
export default function OmniToolLayout() {
  return <Outlet />
}