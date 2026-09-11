import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Loader2, Package, Cpu, Trash2, Pencil } from 'lucide-react'
import { listDevices, getSourceSummary } from '@/services/device.service'
import { listPacks, removePack } from '@/services/pack.service'
import { useProbeStore } from '@/stores/probe.store'
import { useNotificationStore } from '@/stores/notification.store'
import { DeviceTable } from '@/components/DeviceTable'
import type { DeviceInfo, PackInfo, SourceSummary } from '@shared/types'
import { CustomChipDialog } from './CustomChipDialog'
import { PackDeviceSelectDialog } from './PackDeviceSelectDialog'

export function ChipManagement() {
  // ── 设备支持列表 ──
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [summary, setSummary] = useState<SourceSummary | null>(null)
  const [devicesLoading, setDevicesLoading] = useState(true)

  const fetchDevices = useProbeStore((s) => s.fetchDevices)
  const notify = useNotificationStore((s) => s.push)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)

  // ── Pack 设备选择对话框 ──
  const [packDialogOpen, setPackDialogOpen] = useState(false)
  const [packDialogMode, setPackDialogMode] = useState<'import' | 'edit'>('import')
  const [packDialogTarget, setPackDialogTarget] = useState('')

  const refreshDevices = useCallback(async () => {
    setDevicesLoading(true)
    try {
      const [list, s] = await Promise.all([listDevices(), getSourceSummary()])
      setDevices(list)
      setSummary(s)
    } catch (e) {
      notify({ type: 'error', title: '加载设备列表失败', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setDevicesLoading(false)
    }
  }, [notify])

  /** 刷新设备列表，同时同步 probe store（让设备选择弹窗也更新） */
  const refreshAndSync = useCallback(async () => {
    await refreshDevices()
    await fetchDevices()
  }, [refreshDevices, fetchDevices])

  useEffect(() => { refreshAndSync() }, [refreshAndSync])

  // ── CMSIS-Pack 管理 ──
  const [packs, setPacks] = useState<PackInfo[]>([])
  const [packsLoading, setPacksLoading] = useState(true)

  const refreshPacks = useCallback(async () => {
    setPacksLoading(true)
    try {
      const list = await listPacks()
      setPacks(list)
    } catch {
      // ignore
    } finally {
      setPacksLoading(false)
    }
  }, [])

  useEffect(() => { refreshPacks() }, [refreshPacks])

  const handleImportPack = async () => {
    const path = await window.electron.openFileDialog({ extensions: ['pack'], title: '选择 CMSIS-Pack 文件' })
    if (!path) return
    // 打开设备选择对话框
    setPackDialogMode('import')
    setPackDialogTarget(path)
    setPackDialogOpen(true)
  }

  const handleEditPackDevices = (packName: string) => {
    setPackDialogMode('edit')
    setPackDialogTarget(packName)
    setPackDialogOpen(true)
  }

  const handleRemovePack = async (packName: string) => {
    try {
      await removePack(packName)
      notify({ type: 'success', title: `Pack ${packName} 已卸载` })
      await Promise.all([refreshPacks(), refreshAndSync()])
    } catch (e) {
      notify({ type: 'error', title: '卸载失败', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="space-y-4">
      {/* 设备支持列表 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Cpu className="size-4" />
              设备支持列表
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleImportPack}
              >
                DFP 导入芯片
              </Button>
              <Button
                size="sm"
                onClick={() => setCustomDialogOpen(true)}
              >
                自定义芯片
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* 统计 */}
          <div className="mb-4 flex gap-6">
            <div>
              <p className="text-xs text-muted-foreground">总设备数</p>
              <p className="text-lg font-semibold tabular-nums">{summary?.total ?? devices.length}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">内置</p>
              <p className="text-lg font-semibold tabular-nums">{summary?.builtin ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pack 导入</p>
              <p className="text-lg font-semibold tabular-nums">{summary?.pack ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">FLM</p>
              <p className="text-lg font-semibold tabular-nums">{summary?.flm ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">自定义</p>
              <p className="text-lg font-semibold tabular-nums">{summary?.custom ?? 0}</p>
            </div>
          </div>

          {/* 复用 DeviceTable 组件（只读模式） */}
          <DeviceTable
            devices={devices}
            loading={devicesLoading}
            maxHeight="max-h-[460px]"
          />
        </CardContent>
      </Card>

      {/* CMSIS-Pack 管理 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="size-4" />
            CMSIS-Pack 管理
          </CardTitle>
        </CardHeader>
        <CardContent>
          {packsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              加载中...
            </div>
          ) : packs.length === 0 ? (
            <div className="rounded-md border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
              尚未安装任何 CMSIS-Pack
            </div>
          ) : (
            <div className="space-y-2">
              {packs.map((pack) => (
                <div key={pack.name} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{pack.name}</span>
                      <span className="text-xs text-muted-foreground">v{pack.version}</span>
                      {pack.device_count > 0 && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                          {pack.device_count} 设备
                        </span>
                      )}
                      {!pack.file_exists && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                          文件缺失
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEditPackDevices(pack.name)}
                      disabled={!pack.file_exists}
                    >
                      <Pencil className="size-3.5" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemovePack(pack.name)}
                      className="text-red-500 hover:text-red-600"
                    >
                      <Trash2 className="size-3.5" />
                      卸载
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 自定义芯片弹窗 */}
      <CustomChipDialog
        open={customDialogOpen}
        onOpenChange={setCustomDialogOpen}
        onSuccess={refreshAndSync}
      />

      {/* Pack 设备选择弹窗（导入/编辑共用） */}
      <PackDeviceSelectDialog
        open={packDialogOpen}
        onOpenChange={setPackDialogOpen}
        onSuccess={() => Promise.all([refreshPacks(), refreshAndSync()])}
        mode={packDialogMode}
        target={packDialogTarget}
      />
    </div>
  )
}
