import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'

interface PythonStatus {
  running: boolean
  port: number | null
}

/**
 * 管理 Python 后端子进程的生命周期。
 *
 * 启动流程：
 * 1. spawn Python 子进程运行 server.py
 * 2. Python 后端输出首行 JSON {"port": 12345} 表示就绪
 * 3. Electron 读取端口并通过 IPC 暴露给渲染进程
 */
export class PythonBridge {
  private proc: ChildProcess | null = null
  private port: number | null = null
  private ready: Promise<number> | null = null

  getPort(): number | null {
    return this.port
  }

  getStatus(): PythonStatus {
    return {
      running: this.proc !== null && !this.proc.killed && this.port !== null,
      port: this.port
    }
  }

  /**
   * 启动 Python 后端，返回监听端口。
   * 如果已经在运行，直接返回已知端口。
   */
  start(): Promise<number> {
    if (this.port) return Promise.resolve(this.port)
    if (this.ready) return this.ready

    this.ready = new Promise<number>((resolve, reject) => {
      const isDev = !!process.env.ELECTRON_RENDERER_URL
      const pythonExe = this.findPython()
      const scriptPath = this.findScript()

      if (!pythonExe) {
        reject(new Error('Python not found. Please ensure Python is installed and in PATH.'))
        return
      }

      // 开发模式端口来源：环境变量 OMNI_BACKEND_PORT > backend.config.json > 默认 8765；生产模式用 0（自动分配）
      const portArg = isDev ? String(this.resolveDevPort()) : '0'

      // PyInstaller exe 不需要 scriptPath 参数；开发模式需要 server.py
      const args: string[] = []
      let cwd: string
      if (scriptPath) {
        // 开发模式：python server.py --port <port>
        args.push(scriptPath, '--port', portArg)
        cwd = join(scriptPath, '..')
      } else {
        // 生产模式：omni-backend.exe --port 0
        args.push('--port', portArg)
        cwd = join(pythonExe, '..')
      }

      this.proc = spawn(pythonExe, args, {
        cwd,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        windowsHide: true
      })

      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          reject(new Error('Python backend startup timeout (30s)'))
        }
      }, 30000)

      this.proc.stdout?.on('data', (data: Buffer) => {
        const text = data.toString().trim()
        if (!resolved && text.startsWith('{')) {
          // 首行 JSON 包含端口信息
          try {
            const info = JSON.parse(text)
            if (info.port) {
              resolved = true
              this.port = info.port
              clearTimeout(timeout)
              resolve(info.port)
              return
            }
          } catch {
            // 非 JSON，当作普通日志处理
          }
        }
        // 后续日志转发到主进程控制台
        console.log(`[Python] ${text}`)
      })

      this.proc.stderr?.on('data', (data: Buffer) => {
        console.error(`[Python:ERR] ${data.toString().trim()}`)
      })

      this.proc.on('error', (err) => {
        console.error('[Python] process error:', err)
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          reject(err)
        }
      })

      this.proc.on('exit', (code) => {
        console.log(`[Python] process exited with code ${code}`)
        this.proc = null
        this.port = null
        this.ready = null
      })
    })

    return this.ready
  }

  /** 停止 Python 后端 */
  stop(): void {
    if (this.proc) {
      this.proc.kill('SIGTERM')
      this.proc = null
      this.port = null
      this.ready = null
    }
  }

  /**
   * 解析开发模式后端端口。
   * 优先级：环境变量 OMNI_BACKEND_PORT > backend.config.json 的 backendPort > 默认 8765。
   */
  private resolveDevPort(): number {
    const envPort = Number(process.env.OMNI_BACKEND_PORT)
    if (Number.isInteger(envPort) && envPort > 0) return envPort

    const root = this.getProjectRoot()
    const configPath = join(root, 'backend.config.json')
    try {
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        const port = Number(config.backendPort)
        if (Number.isInteger(port) && port > 0) return port
      }
    } catch (err) {
      console.warn('[PythonBridge] invalid backend.config.json, using default port:', err)
    }
    return 8765
  }

  /**
   * 获取项目根目录。
   * 开发模式下 __dirname 是 out/main/，需要向上两级；
   * 生产模式下使用 process.resourcesPath。
   */
  private getProjectRoot(): string {
    const isDev = !!process.env.ELECTRON_RENDERER_URL
    if (isDev) {
      // __dirname = <project>/out/main or <project>/electron
      // 向上查找直到找到 python/server.py
      let dir = __dirname
      for (let i = 0; i < 5; i++) {
        if (existsSync(join(dir, 'python', 'server.py'))) return dir
        dir = join(dir, '..')
      }
    }
    return process.resourcesPath ?? __dirname
  }

  private findPython(): string | null {
    const root = this.getProjectRoot()

    // 优先使用项目虚拟环境（开发模式）
    const venvPython = join(root, '.venv', 'Scripts', 'python.exe')
    if (existsSync(venvPython)) {
      console.log(`[PythonBridge] Using venv Python: ${venvPython}`)
      return venvPython
    }

    // 生产环境：PyInstaller 打包的后端 exe
    // extraResources 将 python/dist/omni-backend/ 复制到 resources/python/
    const bundledExe = join(process.resourcesPath ?? '', 'python', 'omni-backend.exe')
    if (existsSync(bundledExe)) {
      console.log(`[PythonBridge] Using bundled backend: ${bundledExe}`)
      return bundledExe
    }

    // 系统 Python（可能缺少 libusb_package，不推荐）
    console.warn('[PythonBridge] venv Python not found, falling back to system Python')
    return 'python'
  }

  private findScript(): string | null {
    const root = this.getProjectRoot()
    const devPath = join(root, 'python', 'server.py')
    if (existsSync(devPath)) return devPath

    // 生产环境：PyInstaller exe 不需要 script 参数，但 spawn 时需要占位
    // 实际上 exe 本身就是入口，这里返回 null 让调用方处理
    const bundledExe = join(process.resourcesPath ?? '', 'python', 'omni-backend.exe')
    if (existsSync(bundledExe)) {
      return null  // exe 自包含，不需要额外脚本
    }

    const prodPath = join(process.resourcesPath ?? '', 'python', 'server.py')
    if (existsSync(prodPath)) return prodPath

    return null
  }
}
