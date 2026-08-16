import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  /** 获取 Python 后端服务端口 */
  getPythonPort: (): Promise<number | null> => ipcRenderer.invoke('python:get-port'),

  /** 获取 Python 后端状态 */
  getPythonStatus: (): Promise<{ running: boolean; port: number | null }> =>
    ipcRenderer.invoke('python:status'),

  /** 打开文件选择对话框，返回选中文件路径或 null
   *
   *  opts.extensions：指定过滤后缀（如 ['elf','axf']），不传时默认 bin/hex/elf/axf + 所有文件（兼容 Flash 页）。
   *  opts.title：对话框标题，不传时由主进程根据是否指定 extensions 决定默认值。
   */
  openFileDialog: (opts?: { extensions?: string[]; title?: string }): Promise<string | null> =>
    ipcRenderer.invoke('dialog:open-file', opts),

  /** 保存文件对话框，返回保存路径或 null */
  saveFileDialog: (defaultName?: string): Promise<string | null> => ipcRenderer.invoke('dialog:save-file', defaultName),

  /** 从拖拽的 File 对象获取文件路径（Electron 32+ context isolation 下 file.path 不可用） */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** 写入剪贴板文本（file:// 下 navigator.clipboard 不可用，走主进程 clipboard 模块） */
  writeClipboardText: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('clipboard:write-text', text),
}

export type ElectronAPI = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = api
}
