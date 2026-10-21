# OMNI CLI 打包 / 安装（uv + wheel）
# 用法：
#   .\cli-package.ps1                  # 构建 wheel 并安装到 .venv
#   .\cli-package.ps1 -NoBuild         # 跳过构建，仅重装已有 wheel
#   .\cli-package.ps1 -StartBackend    # 安装后用仓库源码启动常驻后端
param(
    [switch]$NoBuild,
    [switch]$StartBackend
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PyDir     = Split-Path -Parent $ScriptDir           # python/
$Repo      = Split-Path -Parent $PyDir               # 仓库根
$VenvPy    = Join-Path $Repo ".venv\Scripts\python.exe"
$Omni      = Join-Path $Repo ".venv\Scripts\omni.exe"
$CliProj   = Join-Path $PyDir "omni_cli"
$DistDir   = Join-Path $PyDir "dist"

if (-not (Test-Path $VenvPy)) { throw "找不到 venv 解释器: $VenvPy" }

if (-not $NoBuild) {
    # 清理 setuptools 的 build/lib、egg-info 和 __pycache__，避免 wheel 带入 .pyc。
    foreach ($cache in @(
        (Join-Path $CliProj "build"),
        (Join-Path $CliProj "omni_cli.egg-info"),
        (Join-Path $CliProj "__pycache__"),
        (Join-Path $CliProj "commands\__pycache__"),
        (Join-Path $CliProj "project\__pycache__")
    )) {
        if (Test-Path -LiteralPath $cache) { Remove-Item -LiteralPath $cache -Recurse -Force }
    }
    Write-Host "[1/3] uv build --wheel" -ForegroundColor Cyan
    uv build $CliProj --wheel --out-dir $DistDir
}

$whl = Get-ChildItem (Join-Path $DistDir "omni_cli-*.whl") -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $whl) { throw "未找到 wheel，请去掉 -NoBuild 先构建一次" }

Write-Host "[2/3] 安装 $($whl.Name) 到 venv" -ForegroundColor Cyan
# --link-mode=copy：避免 uv 缓存与 venv 跨文件系统时的 hardlink 告警
uv pip install --python $VenvPy --reinstall --link-mode=copy $whl.FullName

Write-Host "[3/3] 验证并记录后端位置" -ForegroundColor Cyan
& $Omni --version

# wheel 安装后包不在源码树内，把后端目录写进包内 cli.config.json，
# 这样后续任意目录直接跑 omni（--managed / backend start）都能找到 server.py，
# 无需每次设置环境变量。仍可用 OMNI_BACKEND_DIR / OMNI_BACKEND_SERVER 覆盖。
$saved = & $VenvPy -c "from omni_cli import config; print(config.save_backend_dir(r'$PyDir'))"
Write-Host "已记录后端目录: $saved"

if ($StartBackend) {
    & $Omni backend start
    & $Omni backend status
}

Write-Host ""
Write-Host "完成。常用方式（无需再设环境变量）：" -ForegroundColor Green
Write-Host "  omni backend start          # 启动常驻后端"
Write-Host "  omni probe list             # 自动附加常驻后端"
Write-Host "  omni device summary         # 设备应用库"
Write-Host "  omni project config --target stm32f407ig   # 本地工程配置（无需后端）"
Write-Host "  omni backend stop"
Write-Host ""
Write-Host "  # 单条命令即用即走（临时拉起后端）"
Write-Host "  omni probe list --managed"
Write-Host ""
Write-Host "  # 附加到已在运行的后端（前端/手动启动）"
Write-Host "  omni probe list --backend-port 57123"