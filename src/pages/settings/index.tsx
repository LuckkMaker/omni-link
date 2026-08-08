import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { useMemo, useState } from 'react'
import { useUiStore, TERMINAL_THEMES } from '@/stores/ui.store'
import { ChipManagement } from './ChipManagement'
import { cn } from '@/lib/utils'

type SettingsTab = 'terminal' | 'chips'

export default function SettingsPage() {
  const terminalThemeId = useUiStore((s) => s.terminalThemeId)
  const setTerminalTheme = useUiStore((s) => s.setTerminalTheme)
  const currentTheme = TERMINAL_THEMES.find((t) => t.id === terminalThemeId)
  const [activeTab, setActiveTab] = useState<SettingsTab>('chips')

  // 主题下拉选项按字母顺序排列
  const sortedThemes = useMemo(
    () => [...TERMINAL_THEMES].sort((a, b) => a.name.localeCompare(b.name, 'en')),
    [],
  )

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'chips', label: '芯片管理' },
    { key: 'terminal', label: '终端' },
  ]

  return (
    <div className="p-6">
      {/* Tab 切换 */}
      <div className="mb-4 flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 终端设置 */}
      {activeTab === 'terminal' && (
        <Card>
          <CardHeader>
            <CardTitle>终端</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">终端配色主题</Label>
              <Select
                value={terminalThemeId}
                onValueChange={(v) => setTerminalTheme(v)}
              >
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sortedThemes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {currentTheme && (
                <div className="flex items-center gap-3 pt-2">
                  <span className="text-xs text-muted-foreground">预览：</span>
                  <div
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-mono text-xs"
                    style={{
                      backgroundColor: currentTheme.theme.background,
                      color: currentTheme.theme.foreground,
                    }}
                  >
                    <span style={{ color: currentTheme.theme.cyan }}>root@omni</span>
                    <span>:</span>
                    <span style={{ color: currentTheme.theme.blue }}>~</span>
                    <span style={{ color: currentTheme.theme.green }}>$</span>
                    <span>ls -la</span>
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground pt-1">
                主题会应用到 Commander 和 RTT Viewer 的终端。选择后立即生效并持久化保存。
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 芯片管理 */}
      {activeTab === 'chips' && <ChipManagement />}
    </div>
  )
}
