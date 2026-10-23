<#
.SYNOPSIS
    生成 OMNI 离线工具链包（独立安装器 + tools.json + 压缩包 + 校验和）。

.DESCRIPTION
    输出目录默认 toolchain-release/toolchain-offline/，可作为独立分发包：
      omni-toolchain.exe
      tools.json
      cmake-*.zip / llvm-*.zip / gcc-*.zip / cmsis-toolbox-*.zip / ninja-*.zip
      SHA256SUMS.txt
      README.txt

    用户解压后运行 omni-toolchain.exe --offline . 即可安装到
    %LOCALAPPDATA%/OMNI/toolchains；主安装包也可以通过 NSIS 钩子调用它。

.PARAMETER Manifest
    tools.json 路径，默认 toolchains/tools.json。

.PARAMETER ToolchainExe
    omni-toolchain.exe 路径，默认 python/dist/omni-toolchain.exe。

.PARAMETER OutputDir
    输出根目录，默认 toolchain-release/（不要放 release/，那里会被 electron-builder 清理）。

.PARAMETER Version
    包版本，默认读取 package.json 的 version。

.PARAMETER NoZip
    只生成目录，不生成 zip。

.PARAMETER Clean
    生成前删除同名旧目录/zip。
#>
param(
    [string]$Manifest = "",
    [string]$ToolchainExe = "",
    [string]$OutputDir = "",
    [string]$Version = "",
    [switch]$NoZip,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Manifest) { $Manifest = Join-Path $RepoRoot "toolchains\tools.json" }
if (-not $ToolchainExe) { $ToolchainExe = Join-Path $RepoRoot "python\dist\omni-toolchain.exe" }
if (-not $OutputDir) { $OutputDir = Join-Path $RepoRoot "toolchain-release" }

if (-not (Test-Path -LiteralPath $Manifest)) {
    throw "找不到 tools.json：$Manifest"
}
if (-not (Test-Path -LiteralPath $ToolchainExe)) {
    throw "找不到 omni-toolchain.exe：$ToolchainExe（先运行 python\build.py）"
}
if (-not $Version) {
    $Version = (Get-Content (Join-Path $RepoRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
}

$manifestData = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$tools = @($manifestData.tools)
if ($tools.Count -eq 0) {
    throw "tools.json 里没有 tools：$Manifest"
}

# 目录名固定为 toolchain-offline，便于直接放在 OMNI Link 安装器旁边联动；
# zip 仍带版本号，发布时两者都保留。
$stage = Join-Path $OutputDir "toolchain-offline"
$zipPath = Join-Path $OutputDir "toolchain-offline-$Version.zip"
# 目录是生成物：每次都重建，避免上一版本的旧压缩包混进来。
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if ($Clean -and (Test-Path -LiteralPath $zipPath)) { Remove-Item -LiteralPath $zipPath -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Write-Host "[toolchain-offline] $Version" -ForegroundColor Cyan
Write-Host "[toolchain-offline] stage: $stage" -ForegroundColor DarkGray

Copy-Item -LiteralPath $ToolchainExe -Destination (Join-Path $stage "omni-toolchain.exe") -Force
Copy-Item -LiteralPath $Manifest -Destination (Join-Path $stage "tools.json") -Force

$hashLines = @()
$totalBytes = 0
foreach ($entry in $tools) {
    $archive = $entry.archive
    if (-not $archive) { continue }
    if ([System.IO.Path]::IsPathRooted($archive)) {
        $source = $archive
    } else {
        $source = Join-Path (Split-Path -Parent $Manifest) $archive
    }
    if (-not (Test-Path -LiteralPath $source)) {
        throw "缺少压缩包：$source（$($entry.name) $($entry.version)）"
    }
    $actual = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLower()
    if ($entry.sha256 -and $actual -ne $entry.sha256.ToLower()) {
        throw "$($entry.name) SHA256 不匹配`n  期望 $($entry.sha256.ToLower())`n  实际 $actual"
    }
    $name = Split-Path -Leaf $source
    $dest = Join-Path $stage $name
    if (-not (Test-Path -LiteralPath $dest)) {
        Copy-Item -LiteralPath $source -Destination $dest -Force
    }
    $hashLines += "$actual  $name"
    $totalBytes += (Get-Item -LiteralPath $dest).Length
    Write-Host ("  + {0,-48} {1,8:N1} MB" -f $name, ((Get-Item -LiteralPath $dest).Length / 1MB)) -ForegroundColor Green
}

$exeName = "omni-toolchain.exe"
$exeHash = (Get-FileHash -LiteralPath (Join-Path $stage $exeName) -Algorithm SHA256).Hash.ToLower()
$manifestHash = (Get-FileHash -LiteralPath (Join-Path $stage "tools.json") -Algorithm SHA256).Hash.ToLower()
$hashLines += "$exeHash  $exeName"
$hashLines += "$manifestHash  tools.json"
$hashLines | Set-Content -Path (Join-Path $stage "SHA256SUMS.txt") -Encoding ASCII

$readme = @"
OMNI Link 离线工具链包 $Version

用法（用户级安装，不需要管理员权限）：

  .\omni-toolchain.exe --offline . --install-dir "%LOCALAPPDATA%\OMNI\toolchains"

只安装部分工具：

  .\omni-toolchain.exe --offline . --only cmake --only ninja

查看状态：

  .\omni-toolchain.exe --offline . --list
  .\omni-toolchain.exe --offline . --verify

主安装包联动：
  把本目录（或 zip）放在 OMNI Link 安装器旁边，安装器会检测并调用。

校验：
  Get-FileHash .\*.zip -Algorithm SHA256
"@
$readme | Set-Content -Path (Join-Path $stage "README.txt") -Encoding UTF8

if (-not $NoZip) {
    Write-Host "[toolchain-offline] compressing..." -ForegroundColor Yellow
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal
}

$stageSize = (Get-ChildItem -LiteralPath $stage -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("[toolchain-offline] done: {0:N1} MB (archives {1:N1} MB)" -f ($stageSize / 1MB), ($totalBytes / 1MB)) -ForegroundColor Green
Write-Host "  folder: $stage" -ForegroundColor White
if (-not $NoZip) { Write-Host "  zip:    $zipPath" -ForegroundColor White }
