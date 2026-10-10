import { useEffect, useState } from 'react'
import { RefreshCw, Upload, FileCog, ShieldAlert, Cpu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { wsClient } from '@/services/ws'
import { useOmniToolStore } from './store'
import type { OmniProgress } from './service'
import { DeviceCard } from './components/DeviceCard'
import { ConfirmDialog } from './components/ConfirmDialog'
import { UpgradeProgress } from './components/UpgradeProgress'
import { OperationLog } from './components/OperationLog'

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono">{value}</span>
    </div>
  )
}

export default function OmniToolPage() {
  const devices = useOmniToolStore((s) => s.devices)
  const serialAvailable = useOmniToolStore((s) => s.serialAvailable)
  const session = useOmniToolStore((s) => s.session)
  const info = useOmniToolStore((s) => s.info)
  const filePath = useOmniToolStore((s) => s.filePath)
  const fileSize = useOmniToolStore((s) => s.fileSize)
  const address = useOmniToolStore((s) => s.address)
  const busy = useOmniToolStore((s) => s.busy)
  const progress = useOmniToolStore((s) => s.progress)
  const logs = useOmniToolStore((s) => s.logs)
  const error = useOmniToolStore((s) => s.error)

  const [confirm, setConfirm] = useState<null | 'enterBoot' | 'upgrade'>(null)

  useEffect(() => {
    useOmniToolStore.getState().refreshDevices()
  }, [])

  // 订阅后端升级进度
  useEffect(() => {
    const unsub = wsClient.on('omni_tool.progress', (data) => {
      useOmniToolStore.getState().onProgress(data as OmniProgress)
    })
    return () => unsub()
  }, [])

  const isBoot = session.personality === 'boot'
  const isApp = session.personality === 'app'
  const parsedAddress = Number(address.trim())
  const addressValid = Number.isInteger(parsedAddress) && parsedAddress >= 0
  const canUpgrade = isBoot && !!filePath && addressValid && !busy

  return (
    <div className="flex h-full min-h-0">
      {/* 左：设备列表 */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">OMNI Tool 设备</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => useOmniToolStore.getState().refreshDevices()}
            disabled={busy}
          >
            <RefreshCw className="mr-1 size-3.5" />
            刷新
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
          {!serialAvailable ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              缺少 pyserial，无法枚举串口。请安装依赖后重启后端。
            </div>
          ) : null}
          {devices.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              未发现 OMNI Tool 设备（VID 0xC251 / PID 0x1000 或 0x1001）。
            </div>
          ) : (
            devices.map((d) => (
              <DeviceCard
                key={d.port}
                device={d}
                active={session.connected && session.port === d.port}
                disabled={busy}
                onConnect={() => useOmniToolStore.getState().connect(d.port)}
                onDisconnect={() => useOmniToolStore.getState().disconnect()}
              />
            ))
          )}
        </div>
      </aside>

      {/* 右：操作区 */}
      <section className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        {/* 会话头 */}
        <div className="flex items-center gap-3">
          <Cpu className="size-4 text-muted-foreground" />
          {session.connected ? (
            <>
              <span className="font-medium">{session.port}</span>
              <Badge variant={isBoot ? 'default' : 'secondary'}>
                {isBoot ? 'Bootloader' : isApp ? 'App' : '未知'}
              </Badge>
              <Button size="sm" variant="outline" onClick={() => useOmniToolStore.getState().loadInfo()} disabled={busy}>
                读取设备信息
              </Button>
              <Button size="sm" variant="ghost" onClick={() => useOmniToolStore.getState().disconnect()} disabled={busy}>
                断开
              </Button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">未连接设备，请在左侧选择并连接。</span>
          )}
        </div>

        {/* 设备信息 */}
        {info ? (
          <div className="rounded-md border border-border p-3">
            {info.personality === 'app' ? (
              <>
                <InfoRow label="厂商" value={info.vendor || '—'} />
                <InfoRow label="产品" value={info.product || '—'} />
                <InfoRow label="固件版本" value={info.fw_ver || '—'} />
                <InfoRow label="序列号" value={info.serial_number || '（固件暂未提供）'} />
                <InfoRow
                  label="能力位"
                  value={
                    info.capabilities != null
                      ? `0x${info.capabilities.toString(16).toUpperCase().padStart(4, '0')}`
                      : '—'
                  }
                />
                <InfoRow
                  label="包参数"
                  value={
                    info.packet_size != null && info.packet_count != null
                      ? `${info.packet_size} bytes × ${info.packet_count}`
                      : '—'
                  }
                />
              </>
            ) : (
              <>
                <InfoRow label="Boot 版本" value={info.boot_version_str} />
                <InfoRow label="MCU UID" value={info.mcu_uid} />
              </>
            )}
          </div>
        ) : null}

        {/* App：一键进入 bootloader */}
        {isApp ? (
          <div className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center gap-2 text-sm">
              <ShieldAlert className="size-4 text-amber-500" />
              <span className="font-medium">固件自升级</span>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              进入 bootloader 后，工具将复位并重新枚举为 boot（PID 0x1000）。
              <span className="text-amber-600"> 当前 CMSIS-DAP 调试会话会被中断。</span>
            </p>
            <Button variant="destructive" disabled={busy} onClick={() => setConfirm('enterBoot')}>
              一键进入 Bootloader
            </Button>
          </div>
        ) : null}

        {/* Boot：选择固件 + 地址 + 升级 */}
        {isBoot ? (
          <div className="rounded-md border border-border p-3">
            <div className="mb-2 flex items-center gap-2 text-sm">
              <ShieldAlert className="size-4 text-amber-500" />
              <span className="font-medium">固件自升级（擦除 + 下载 + 回读校验 + 跳转）</span>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1 text-xs text-muted-foreground">固件文件 (.bin)</div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => useOmniToolStore.getState().chooseFile()}>
                    <FileCog className="mr-1 size-3.5" />
                    选择文件
                  </Button>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {filePath ? `${filePath}${fileSize != null ? `（${fileSize} bytes）` : ''}` : '未选择'}
                  </span>
                </div>
              </div>

              <div className="w-48">
                <div className="mb-1 text-xs text-muted-foreground">目标地址</div>
                <Input
                  value={address}
                  onChange={(e) => useOmniToolStore.getState().setAddress(e.target.value)}
                  disabled={busy}
                  className={!addressValid ? 'border-destructive' : undefined}
                  placeholder="0x08010000"
                />
              </div>

              <Button variant="destructive" disabled={!canUpgrade} onClick={() => setConfirm('upgrade')}>
                <Upload className="mr-1 size-3.5" />
                开始升级
              </Button>
            </div>

            <p className="mt-2 text-xs text-muted-foreground">
              App 区 0x08010000 ~ 0x080E0000。回读校验失败时不会执行跳转。
            </p>
          </div>
        ) : null}

        {/* 进度 */}
        {progress ? (
          <div className="rounded-md border border-border p-3">
            <UpgradeProgress progress={progress} />
          </div>
        ) : null}

        {/* 错误 */}
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        {/* 日志 */}
        <OperationLog logs={logs} onClear={() => useOmniToolStore.getState().clearLogs()} />
      </section>

      {/* 二次确认 */}
      <ConfirmDialog
        open={confirm === 'enterBoot'}
        title="进入 Bootloader"
        description="设备将写入 magic 并立即复位，当前 CMSIS-DAP 调试会话会中断。确认继续？"
        confirmLabel="进入 Bootloader"
        busy={busy}
        onOpenChange={(o) => !o && setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          useOmniToolStore.getState().enterBoot()
        }}
      />

      <ConfirmDialog
        open={confirm === 'upgrade'}
        title="开始升级（不可逆）"
        description={
          <>
            <div>固件：{filePath ?? '未选择'}</div>
            <div>地址：{address}</div>
            <div className="mt-2">
              将擦除目标地址覆盖的扇区并写入固件，过程中请勿拔线或断电。
              校验不通过时不会跳转。
            </div>
          </>
        }
        confirmLabel="开始升级"
        busy={busy}
        onOpenChange={(o) => !o && setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          useOmniToolStore.getState().startUpgrade()
        }}
      />
    </div>
  )
}