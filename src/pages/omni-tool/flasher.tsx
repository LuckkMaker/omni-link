import { useEffect, useState } from 'react'
import {
  Cpu,
  Flame,
  FileText,
  FolderOpen,
  HardDriveDownload,
  Loader2,
  Rocket,
  ShieldCheck,
  Trash2,
  Usb,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { HexViewer } from '@/pages/flash/components/HexViewer'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from './components/ConfirmDialog'
import { useOmniToolStore } from './store'
import { useFlasherStore } from './flasher.store'
import { wsClient } from '@/services/ws'
import type { OmniProgress } from './service'

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function formatHex(addr: number): string {
  return `0x${addr.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * OMNI Tool / Flasher 子页面：把 OMNI Tool 当作 CMSIS-DAP / SWD 探针，
 * 在线烧录**外部目标 MCU**（与 Boot 页给自身刷固件是两条独立链路）。
 *
 * 固件侧链路：MODE(FLASHER) -> OPEN -> (ERASE) -> WRITE×N -> CLOSE
 *          -> 重 OPEN -> READ×N 比对 -> CLOSE -> MODE(DAP)
 *
 * 目标型号由固件内置 FLM 决定（FLASHER_PLAN 阶段 B 在线下发 FLM 未实现），
 * 当前仅支持 stm32f407ig。
 */
export default function FlasherPage() {
  const session = useOmniToolStore((s) => s.session)
  const serialAvailable = useOmniToolStore((s) => s.serialAvailable)

  const status = useFlasherStore((s) => s.status)
  const target = useFlasherStore((s) => s.target)
  const image = useFlasherStore((s) => s.image)
  const chipErase = useFlasherStore((s) => s.chipErase)
  const readbackVerify = useFlasherStore((s) => s.readbackVerify)
  const busy = useFlasherStore((s) => s.busy)
  const lastResult = useFlasherStore((s) => s.lastResult)

  const [confirmFlash, setConfirmFlash] = useState(false)

  // 设备/会话变化会影响可用性，进入页面与连接切换时都要刷新
  useEffect(() => {
    useFlasherStore.getState().refreshStatus()
  }, [session.connected, session.port, session.personality])

  useEffect(() => {
    useOmniToolStore.getState().refreshDevices()
  }, [])

  // 烧录进度经同一 WebSocket 通道推送
  useEffect(() => {
    const unsub = wsClient.on('omni_tool.progress', (data) => {
      useFlasherStore.getState().onProgress(data as OmniProgress)
    })
    return () => unsub()
  }, [])

  const connected = session.connected
  // 在线烧录只能走 app 人格：boot 固件只有 IAP，没有 SWD
  const isApp = session.personality === 'app'
  const available = !!status?.available && isApp
  const hasImage = !!image && !image.loading && image.size > 0
  const canFlash = available && hasImage && !busy

  if (!connected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Usb className="size-10 opacity-30" />
        <p className="text-sm">OMNI Tool 未连接</p>
        {!serialAvailable ? (
          <p className="text-xs text-destructive">缺少 pyserial，无法枚举串口</p>
        ) : (
          <p className="text-xs">请在顶部设备栏选择并连接 OMNI Tool 设备</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部工具栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={!canFlash}
          onClick={() => setConfirmFlash(true)}
          className="h-8 gap-1.5"
          title="MODE(FLASHER) → 擦除 → 写入 → 回读校验 → 切回 DAP"
        >
          <Rocket className="size-3.5" />
          <span>Flash Target</span>
        </Button>

        <span className="mx-1 h-5 w-px bg-border" />

        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !isApp}
          onClick={() => useFlasherStore.getState().recover()}
          className="h-8 gap-1.5"
          title="目标复位并重建 SWD 链路。仅在烧录失败且设备仍停在 FLASHER 模式时需要；烧录失败会自动清场"
        >
          <HardDriveDownload className="size-3.5" />
          <span>Recover</span>
        </Button>

        <div className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Cpu className="size-3" />
            {target.toUpperCase()}
          </span>
          {status ? <span>· {status.max_payload} B/包</span> : null}
        </div>
      </div>

      {/* 连接人格不符时给出明确原因 */}
      {connected && !isApp ? (
        <div className="shrink-0 border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-500">
          当前设备处于 bootloader 模式，仅提供自身 IAP，无法烧录外部目标。
          请切到 <b>Boot</b> 子页面执行「Enter Bootloader」回到 app 模式，或给工具断电重插。
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
        {/* 配置卡片：目标型号 + 烧写模式 + 选项 */}
        <div className="shrink-0 space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">目标芯片</span>
            <Badge variant="outline">{target.toUpperCase()}</Badge>
            <span className="text-[11px] text-muted-foreground">
              由固件内置 FLM 决定，暂不支持其它型号
            </span>
          </div>

          {/* 烧录选项 */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <label className="flex items-center gap-2">
              <Switch
                checked={chipErase}
                onCheckedChange={(v) => useFlasherStore.getState().setChipErase(v)}
                disabled={busy}
              />
              <Flame className="size-3.5 text-muted-foreground" />
              <span>烧录前整片擦除</span>
            </label>

            <label className="flex items-center gap-2">
              <Switch
                checked={readbackVerify}
                onCheckedChange={(v) => useFlasherStore.getState().setReadbackVerify(v)}
                disabled={busy}
              />
              <ShieldCheck className="size-3.5 text-muted-foreground" />
              <span>写后回读校验</span>
            </label>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            bin 与 hex 一律走固件**镜像模式**（<code className="font-mono">OPEN_IMAGE</code>）：固件自己
            判定格式并解出地址，hex 可直接烧，不用先转 bin。两种格式最终都进同一个 flash manager，
            **扇区懒擦除由固件完成**（跨扇区才擦），所以关掉「整片擦除」也能正确写入。
            开启整片擦除时会先用地址模式走一趟 <code className="font-mono">OPEN → ERASE → CLOSE</code> 清场，
            耗时可达数十秒。
            回读校验需在写完 <code className="font-mono">CLOSE</code> 后**重新 OPEN** 再次 halt 目标，
            因此耗时约为写入的 0.6 倍。
          </p>
        </div>

        {/* 镜像选择 */}
        <div className="flex shrink-0 items-center gap-2 rounded-md border border-border p-3">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !available}
            onClick={() => useFlasherStore.getState().openImage()}
            className="h-8 gap-1.5"
          >
            <FolderOpen className="size-3.5" />
            选择固件
          </Button>

          {image ? (
            <>
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-xs">{image.title}</span>
              <Badge variant="outline" className="shrink-0 uppercase">
                {image.format}
              </Badge>
              <span className="shrink-0 text-xs text-muted-foreground">
                {image.loading ? (
                  <Loader2 className="mr-1 inline size-3 animate-spin" />
                ) : null}
                {formatBytes(image.size)}
                {image.format === 'hex' && image.fileSize !== image.size ? (
                  <span className="ml-1 opacity-70">
                    ({image.fileSize} B 文本)
                  </span>
                ) : null}
                {' @ '}
                {formatHex(image.address)}
                {image.segments.length > 1 ? (
                  <span className="ml-1 opacity-70">{image.segments.length} 段</span>
                ) : null}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => useFlasherStore.getState().clearImage()}
                className="h-7 w-7 p-0"
                title="清除已选固件"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              未选择固件（支持 .bin / .hex）
            </span>
          )}
        </div>

        {/* 镜像预览 */}
        {image?.data ? (
          <div className="min-h-[240px] flex-1 overflow-hidden rounded-md border border-border">
            <HexViewer
              base64Data={image.data}
              baseAddress={image.address}
              byteWidth={1}
              persistedScrollTop={0}
            />
          </div>
        ) : null}

        {/* 段信息与 CRC32（hex 可能多段；CRC32 是模式 B 的固件侧校验依据） */}
        {image && !image.loading && image.segments.length > 0 ? (
          <div className="shrink-0 rounded-md border border-border bg-muted/30 p-3 text-xs">
            <div className="font-medium">镜像信息</div>
            <div className="mt-1 space-y-0.5 text-muted-foreground">
              {image.segments.slice(0, 8).map((s) => (
                <div key={s.address}>
                  段 {formatHex(s.address)} – {formatHex(s.address + s.size)}（
                  {formatBytes(s.size)}）
                </div>
              ))}
              {image.segments.length > 8 ? (
                <div className="opacity-70">… 另有 {image.segments.length - 8} 段</div>
              ) : null}
              {image.crc32 ? (
                <div className="font-mono">
                  整镜像 CRC32 = 0x{image.crc32.toString(16).toUpperCase().padStart(8, '0')}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 上次结果 */}
        {lastResult ? (
          <div className="shrink-0 rounded-md border border-border bg-muted/30 p-3 text-xs">
            <div className="font-medium text-green-600 dark:text-green-500">
              <ShieldCheck className="mr-1 inline size-3.5" />
              上次烧录成功
            </div>
            <div className="mt-1 text-muted-foreground">
              {formatBytes(lastResult.size)} @ {formatHex(lastResult.address)} ·{' '}
              {lastResult.isHex ? 'HEX' : 'BIN'} 镜像模式 · {lastResult.segments} 段
              {lastResult.verified ? ' · 回读校验通过' : ' · 未执行校验'}
            </div>
          </div>
        ) : null}
      </div>

      {/* 烧录二次确认（不可逆：会擦除目标芯片） */}
      <ConfirmDialog
        open={confirmFlash}
        title="开始烧录目标芯片"
        description={
          <>
            <div>目标：{target.toUpperCase()}</div>
            <div>固件：{image?.title ?? '未选择'}</div>
            <div>
              地址：{formatHex(image?.address ?? 0)} · {formatBytes(image?.size ?? 0)}
              {image && image.segments.length > 1 ? ` · ${image.segments.length} 段` : ''}
            </div>
            <div>
              方式：镜像模式（{image?.format === 'hex' ? 'HEX' : 'BIN'}，地址由固件解析）
            </div>
            <div className="mt-2">
              {chipErase
                ? '将先整片擦除目标 Flash 再写入，耗时可能达数十秒以上。'
                : '不做整片擦除，由固件按扇区懒擦除（跨扇区才擦）。'}
              固件侧会校验整镜像 CRC32
              {readbackVerify ? '，写完再回读逐字节比对' : '（本次未开启回读校验）'}。
              过程中请勿断开 SWD 或给目标断电。
            </div>
          </>
        }
        confirmLabel="开始烧录"
        busy={busy}
        onOpenChange={(o) => !o && setConfirmFlash(false)}
        onConfirm={() => {
          setConfirmFlash(false)
          useFlasherStore.getState().startFlash()
        }}
      />
    </div>
  )
}