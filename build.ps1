<#
.SYNOPSIS
    OMNI Link 一键打包脚本（Windows）
.DESCRIPTION
    自动完成三步构建：
      1. PyInstaller 打包 Python 后端 -> python/dist/omni-backend/
      2. electron-vite 构建前端       -> out/
      3. electron-builder 生成安装包   -> release/

    脚本会自动查找安装了后端依赖的 Python，无需手动指定路径。
.PARAMETER Clean
    打包前清理旧构建产物
.PARAMETER Python
    指定 Python 可执行文件路径（默认自动检测）
.PARAMETER SkipBackend
    跳过后端打包（如果你已经手动打过包）
.PARAMETER SkipFrontend
    跳过前端构建 + 安装包生成
.EXAMPLE
    .\build.ps1
    .\build.ps1 -Clean
    .\build.ps1 -Python "C:\Python312\python.exe"
    .\build.ps1 -SkipBackend
#>
param(
    [switch]$Clean,
    [string]$Python,
    [switch]$SkipBackend,
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  OMNI Link Build Script" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# Step 0: Find Python with required dependencies
# ---------------------------------------------------------------------------
function Find-Python {
    if ($Python) {
        if (Test-Path $Python) { return $Python }
        Write-Host "ERROR: Python not found at '$Python'" -ForegroundColor Red
        exit 1
    }

    $candidates = @(
        "$ProjectRoot\.venv\Scripts\python.exe",
        (Get-Command python -ErrorAction SilentlyContinue).Source,
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }

    # 必需的运行时依赖。
    # 注意：pyocd 是内置源码（python/pyocd/），必须在 python/ 目录下才能 import；
    # pyusb / hidapi 是 pyOCD 可选 USB 后端，项目实际用 libusb_package，不强制检测。
    $required = @("fastapi", "uvicorn", "pyocd", "libusb_package", "capstone", "intelhex", "jinja2", "yaml")
    $pythonDir = (Join-Path $ProjectRoot "python").Replace('\', '\\')

    foreach ($py in $candidates) {
        $allOk = $true
        $missing = @()
        foreach ($pkg in $required) {
            # 把 python/ 目录加入 sys.path，让内置的 pyocd 源码包可被 import
            $result = & $py -c "import sys; sys.path.insert(0, r'$pythonDir'); import $pkg" 2>&1
            if ($LASTEXITCODE -ne 0) {
                $allOk = $false
                $missing += $pkg
            }
        }
        if ($allOk) {
            $ver = & $py --version 2>&1
            Write-Host "[build] Found Python: $py ($ver)" -ForegroundColor Green
            return $py
        } else {
            Write-Host "[build] $py missing: $($missing -join ', ')" -ForegroundColor DarkGray
        }
    }

    Write-Host "ERROR: No Python with required dependencies found." -ForegroundColor Red
    Write-Host "  Install dependencies with:" -ForegroundColor Yellow
    Write-Host "  .\.venv\Scripts\pip.exe install -r python\requirements.txt" -ForegroundColor Yellow
    exit 1
}

$pyExe = Find-Python

# ---------------------------------------------------------------------------
# Step 1: Build backend with PyInstaller
# ---------------------------------------------------------------------------
if (-not $SkipBackend) {
    Write-Host ""
    Write-Host "--- Step 1/3: PyInstaller backend ---" -ForegroundColor Yellow
    $buildArgs = @("python\build.py")
    if ($Clean) { $buildArgs += "--clean" }
    & $pyExe $buildArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Backend build failed." -ForegroundColor Red
        exit 1
    }
    Write-Host "[build] Backend packaged successfully." -ForegroundColor Green

    # Verify backend exe exists
    $backendExe = "$ProjectRoot\python\dist\omni-backend\omni-backend.exe"
    if (-not (Test-Path $backendExe)) {
        Write-Host "ERROR: Backend executable not found at '$backendExe'" -ForegroundColor Red
        exit 1
    }
    $backendSizeMB = [math]::Round((Get-Item $backendExe).Length / 1MB, 1)
    Write-Host "[build] Backend exe: $backendExe ($backendSizeMB MB)" -ForegroundColor Green
} else {
    Write-Host "[build] Skipping backend build." -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Step 2: Build frontend with electron-vite
# ---------------------------------------------------------------------------
if (-not $SkipFrontend) {
    Write-Host ""
    Write-Host "--- Step 2/3: electron-vite build ---" -ForegroundColor Yellow
    Push-Location $ProjectRoot
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Frontend build failed." -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location
    Write-Host "[build] Frontend built successfully." -ForegroundColor Green

    # -----------------------------------------------------------------------
    # Step 3: Generate Windows installer with electron-builder
    # -----------------------------------------------------------------------
    Write-Host ""
    Write-Host "--- Step 3/3: electron-builder (Windows installer) ---" -ForegroundColor Yellow

    # Ensure electron-builder is available
    if (-not (Get-Command electron-builder -ErrorAction SilentlyContinue) -and -not (Test-Path "node_modules\.bin\electron-builder.cmd")) {
        Write-Host "[build] Installing electron-builder..." -ForegroundColor Yellow
        npm install --save-dev electron-builder
    }

    # Clean release/ directory to avoid stale build artifacts (e.g. win-unpacked.tmp
    # from interrupted builds, or old installer exe with previous version number).
    # electron-builder does not always clean up its temp dirs, and stale win-unpacked.tmp
    # can cause it to skip re-unpacking the Electron framework, leading to inconsistent
    # builds where the version number does not update.
    $releaseDir = "$ProjectRoot\release"
    if (Test-Path $releaseDir) {
        Write-Host "[build] Cleaning release/ directory..." -ForegroundColor DarkGray
        Remove-Item $releaseDir -Recurse -Force
    }

    Push-Location $ProjectRoot

    # electron-builder 打包时需要从 GitHub 下载 winCodeSign / nsis 等工具，
    # 国内网络访问 GitHub 容易超时（ETIMEDOUT），使用 npmmirror 镜像加速。
    # 如需恢复官方源，删除此环境变量即可。
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

    npx electron-builder --win 2>&1 | Tee-Object -Variable buildOutput
    Pop-Location

    # electron-builder may exit with non-zero on warnings; check for actual output
    $installer = Get-ChildItem "$ProjectRoot\release\*Setup*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $installer) {
        $installer = Get-ChildItem "$ProjectRoot\dist\*Setup*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if ($installer) {
        Write-Host "[build] Installer generated successfully." -ForegroundColor Green
    } else {
        Write-Host "WARNING: Installer not found. Check electron-builder output above." -ForegroundColor Yellow
        Write-Host "  (This is OK if you only need the unpacked app)" -ForegroundColor Yellow
    }
} else {
    Write-Host "[build] Skipping frontend build." -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Build Complete!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
if (-not $SkipFrontend) {
    Write-Host ""
    Write-Host "Installer:" -ForegroundColor White
    Get-ChildItem "$ProjectRoot\release\*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
        $sizeMB = [math]::Round($_.Length / 1MB, 1)
        Write-Host "  $($_.Name)  ($sizeMB MB)" -ForegroundColor Green
        Write-Host "  $($_.FullName)" -ForegroundColor DarkGray
    }
    if (-not (Test-Path "$ProjectRoot\release\*.exe")) {
        Write-Host "  (No installer found in release/)" -ForegroundColor Yellow
    }
}
if (-not $SkipBackend) {
    Write-Host ""
    Write-Host "Backend:" -ForegroundColor White
    $backendExe = "$ProjectRoot\python\dist\omni-backend"
    if (Test-Path $backendExe) {
        $totalSize = (Get-ChildItem $backendExe -Recurse | Measure-Object -Property Length -Sum).Sum
        $totalSizeMB = [math]::Round($totalSize / 1MB, 1)
        Write-Host "  omni-backend/  ($totalSizeMB MB)" -ForegroundColor Green
        Write-Host "  $backendExe" -ForegroundColor DarkGray
    }
}
Write-Host ""
