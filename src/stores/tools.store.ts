import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 工具页配置持久化 store
 * 保存 Number Converter 和 Map Analyzer 的配置状态，
 * 切换页面后返回时恢复历史配置。
 */

interface ToolsState {
  // Number Converter
  ncDecimal: string
  ncHex: string
  ncBinary: string

  // Map Analyzer
  maActiveTab: 'rom' | 'ram' | 'stack' | 'all'
  maSortKey: string
  maSortDir: 'asc' | 'desc'

  // setters
  setNcValues: (decimal: string, hex: string, binary: string) => void
  setMaSort: (key: string, dir: 'asc' | 'desc') => void
  setMaTab: (tab: 'rom' | 'ram' | 'stack' | 'all') => void
}

export const useToolsStore = create<ToolsState>()(
  persist(
    (set) => ({
      // Number Converter 默认值
      ncDecimal: '0',
      ncHex: '0',
      ncBinary: '0',

      // Map Analyzer 默认值
      maActiveTab: 'rom',
      maSortKey: 'rom',
      maSortDir: 'desc',

      setNcValues: (decimal, hex, binary) =>
        set({ ncDecimal: decimal, ncHex: hex, ncBinary: binary }),

      setMaSort: (key, dir) => set({ maSortKey: key, maSortDir: dir }),

      setMaTab: (tab) => set({ maActiveTab: tab }),
    }),
    {
      name: 'tools-config',
      // 只持久化数据，不持久化函数
      partialize: (state) => ({
        ncDecimal: state.ncDecimal,
        ncHex: state.ncHex,
        ncBinary: state.ncBinary,
        maActiveTab: state.maActiveTab,
        maSortKey: state.maSortKey,
        maSortDir: state.maSortDir,
      }),
    }
  )
)
