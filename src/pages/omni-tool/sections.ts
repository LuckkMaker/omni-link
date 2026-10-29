// OMNI Tool 子功能路由表。
// 与 MainLayout 侧边栏的"Omni Tool"二级菜单共用，保证两处入口永远一致。

/** 子功能 id（用作 /omni-tool/:id 的路径段） */
export type OmniToolSection = 'boot' | 'flasher'

/** 默认进入的子功能 */
export const DEFAULT_SECTION: OmniToolSection = 'boot'

export interface OmniToolNavItem {
  id: OmniToolSection
  label: string
  description: string
}

export const OMNI_TOOL_SECTIONS: OmniToolNavItem[] = [
  { id: 'boot', label: 'Boot', description: '给 OMNI Tool 自身刷固件（app → boot IAP）' },
  { id: 'flasher', label: 'Flasher', description: '把 OMNI Tool 当探针，在线烧录外部目标' },
]

/** 路径合法性校验（供路由与侧边栏高亮共用） */
export function isOmniToolSection(id: string): id is OmniToolSection {
  return OMNI_TOOL_SECTIONS.some((s) => s.id === id)
}

/** 该路径是否属于 OMNI Tool 区域（DeviceSwitcher 据此自动切到 OMNI 设备池） */
export function isOmniToolPath(pathname: string): boolean {
  return pathname === '/omni-tool' || pathname.startsWith('/omni-tool/')
}