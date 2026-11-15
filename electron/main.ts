// OMNI Link
// Copyright (c) 2026 LuckkMaker
// SPDX-License-Identifier: MIT

import { app, BrowserWindow, ipcMain, shell, dialog, clipboard } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { PythonBridge } from './python-bridge'

let mainWindow: BrowserWindow | null = null
let pythonBridge: PythonBridge | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: `OMNI Link v${app.getVersion()}`,
    icon: join(__dirname, '../../assets/images/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function startPythonBackend(): Promise<void> {
  pythonBridge = new PythonBridge()
  try {
    const port = await pythonBridge.start()
    console.log(`[Python Backend] started on port ${port}`)
  } catch (err) {
    console.error('[Python Backend] failed to start:', err)
  }
}

/**
 * 解析随安装包分发的 tools/ 目录。
 * 生产：<安装目录>/tools（electron-builder extraFiles 复制到应用根）。
 * 开发：仓库根/tools。
 */
function resolveToolsDir(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, '..', 'tools')]
    : [join(process.cwd(), 'tools'), join(__dirname, '..', '..', 'tools')]
  return candidates.find((path) => existsSync(path)) ?? null
}

interface DialogOptions {
  extensions?: string[]
  title?: string
  /** 路径记忆分组键：同一 key 的对话框共享上次打开目录 */
  pathKey?: string
}

// 文件选择对话框的路径记忆（存于 userData/dialog-paths.json，按 pathKey 分组）
let dialogDirs: Record<string, string> | null = null

function dialogDirsFile(): string {
  return join(app.getPath('userData'), 'dialog-paths.json')
}

function loadDialogDirs(): Record<string, string> {
  if (dialogDirs) return dialogDirs
  try {
    const raw = JSON.parse(readFileSync(dialogDirsFile(), 'utf-8')) as Record<string, string>
    dialogDirs = raw && typeof raw === 'object' ? raw : {}
  } catch {
    dialogDirs = {}
  }
  return dialogDirs
}

/** 返回可用的上次目录，目录已不存在时回落到系统默认位置 */
function getRememberedDir(key: string): string | undefined {
  const dir = loadDialogDirs()[key]
  return dir && existsSync(dir) ? dir : undefined
}

function rememberDir(key: string, filePath: string): void {
  const dir = dirname(filePath)
  if (!dir || !existsSync(dir)) return
  const dirs = loadDialogDirs()
  if (dirs[key] === dir) return
  dirs[key] = dir
  try {
    writeFileSync(dialogDirsFile(), JSON.stringify(dirs, null, 2), 'utf-8')
  } catch (err) {
    console.error('[Dialog] 保存路径记忆失败:', err)
  }
}

app.whenReady().then(async () => {
  const toolsDir = resolveToolsDir()
  if (toolsDir) {
    process.env.OMNI_TOOLS_DIR = toolsDir
    console.log(`[Tools] using bundled tools: ${toolsDir}`)
  }

  // 设置用户数据目录环境变量，供 Python 后端数据库使用
  // 生产模式下数据库会写入该用户可写目录（避免 Program Files 只读问题）
  // 开发模式下若未设置该变量，Python 仍会使用源码目录下 data/devices.db
  process.env.OMNI_DATA_DIR = app.getPath('userData')

  await startPythonBackend()

  // IPC: 获取 Python 后端端口
  ipcMain.handle('python:get-port', () => {
    return pythonBridge?.getPort() ?? null
  })

  // IPC: Python 后端状态
  ipcMain.handle('python:status', () => {
    return pythonBridge?.getStatus() ?? { running: false, port: null }
  })

  // IPC: 写入剪贴板文本
  //   生产环境渲染进程以 file:// 加载（非安全上下文），navigator.clipboard 不可用，
  //   故统一走主进程 clipboard 模块，保证复制在 Electron 内始终可用。
  ipcMain.handle('clipboard:write-text', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })

  // IPC: 打开文件选择对话框
  //   opts.extensions：指定过滤后缀（如 ['elf','axf']），不传时默认 bin/hex/elf/axf + 所有文件（兼容 Flash 页）
  //   opts.title：对话框标题
  //   opts.pathKey：路径记忆分组键，相同 key 的对话框共享上次打开目录
  ipcMain.handle('dialog:open-file', async (_event, opts?: DialogOptions) => {
    // 根据是否指定 extensions 动态构造 filters，未指定时保留原有 bin/hex/elf/axf + 所有文件
    const filters = opts?.extensions?.length
      ? [
          { name: `${opts.extensions.join('/').toUpperCase()} 文件`, extensions: opts.extensions },
          { name: '所有文件', extensions: ['*'] },
        ]
      : [
          { name: '固件文件', extensions: ['bin', 'hex', 'elf', 'axf'] },
          { name: '所有文件', extensions: ['*'] },
        ]
    const title = opts?.title ?? (opts?.extensions?.length ? '选择文件' : '选择固件文件')
    const result = await dialog.showOpenDialog(mainWindow!, {
      title,
      filters,
      defaultPath: getRememberedDir(opts?.pathKey ?? title),
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    rememberDir(opts?.pathKey ?? title, result.filePaths[0])
    return result.filePaths[0]
  })

  // IPC: 保存文件对话框
  ipcMain.handle('dialog:save-file', async (_event, defaultName: string) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '保存文件',
      defaultPath: defaultName || getRememberedDir('save') || 'flash_dump.bin',
      filters: [
        { name: '二进制文件', extensions: ['bin'] },
        { name: 'Intel HEX', extensions: ['hex'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) return null
    rememberDir('save', result.filePath)
    return result.filePath
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  pythonBridge?.stop()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  pythonBridge?.stop()
})
