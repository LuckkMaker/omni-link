<#
.SYNOPSIS
    从本地压缩包/解压目录填充 tools/，供 electron-builder 打包。

.DESCRIPTION
    当前安装包不会自动下载工具链；本脚本把本机已有的工具整理成
    tools/README.md 约定的布局，然后 build.ps1 / electron-builder 会原样打包。

    支持 .zip 和已解压目录。默认从 $env:OMNI_TOOLCHAIN_SOURCE、toolchains/
    或 D:\ToolChain 自动查找 cmake / ninja / LLVM Embedded / Arm GNU Toolchain /
    CMSIS-Toolbox；找不到时还会看 tools/ 里直接放的 zip。

.PARAMETER Source
    搜索压缩包/目录的根。默认 OMNI_TOOLCHAIN_SOURCE → toolchains/ → D:\ToolChain
    → tools/。

.PARAMETER Cmake
    CMake 的 zip 或解压目录；不传时自动查找 cmake-*-windows-*。

.PARAMETER Ninja
    ninja.exe、包含 ninja.exe 的目录，或 ninja 的 zip；不传时自动查找或使用 PATH。

.PARAMETER Llvm
    LLVM Embedded 的 zip 或解压目录；不传时自动查找 clang.exe。

.PARAMETER Gcc
    Arm GNU Toolchain 的 zip 或解压目录；不传时自动查找 arm-none-eabi-gcc.exe。

.PARAMETER CmsisToolbox
    CMSIS-Toolbox 的 zip 或解压目录；不传时自动查找 cbuild.exe。

.PARAMETER Clean
    先删除 tools/ 下已知的工具目录；README 和 zip/7z 压缩包会保留。

.PARAMETER Force
    目标已存在时覆盖；默认跳过。

.PARAMETER DryRun
    只打印将要执行的动作；压缩包只提示“会解压”，不实际复制。

.EXAMPLE
    .\scripts\prepare-tools.ps1 -DryRun
    .\scripts\prepare-tools.ps1
    .\scripts\prepare-tools.ps1 -Source toolchains -Clean -Force
#>
param(
    [string]$Source = "",
    [string]$Cmake = "",
    [string]$Ninja = "",
    [string]$Llvm = "",
    [string]$Gcc = "",
    [string]$CmsisToolbox = "",
    [switch]$Clean,
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ToolsRoot = Join-Path $RepoRoot "tools"
$ToolchainRoot = Join-Path $RepoRoot "toolchains"
$script:TempDirs = @()

function Write-Step([string]$Message) {
    Write-Host "[tools] $Message" -ForegroundColor Cyan
}

function Ensure-ToolsRoot {
    if (-not (Test-Path -LiteralPath $ToolsRoot)) {
        if ($DryRun) {
            Write-Step "would create $ToolsRoot"
        } else {
            New-Item -ItemType Directory -Path $ToolsRoot -Force | Out-Null
        }
    }
}

function Remove-ToolTarget([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if ($DryRun) {
        Write-Step "would remove $Path"
        return
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Find-ToolExe([string]$Root, [string]$Name) {
    return Get-ChildItem -LiteralPath $Root -Recurse -Filter $Name -File -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}

function Find-Archive([string[]]$Patterns) {
    $roots = @($Source, $ToolchainRoot, $ToolsRoot) | Where-Object { $_ } | Select-Object -Unique
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($pattern in $Patterns) {
            $file = Get-ChildItem -LiteralPath $root -Filter $pattern -File -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending | Select-Object -First 1
            if ($file) { return $file.FullName }
        }
    }
    return $null
}

function Get-Version([string]$Text, [string]$Pattern = '(\d+\.\d+\.\d+)') {
    if ($Text -match $Pattern) { return $Matches[1] }
    return $null
}

function Invoke-Version([string]$Exe, [string]$Pattern) {
    if (-not (Test-Path -LiteralPath $Exe)) { return $null }
    try {
        $text = (& $Exe --version 2>&1 | Out-String)
        return Get-Version $text $Pattern
    } catch {
        return $null
    }
}

function Expand-ToTemp([string]$Archive) {
    if ($Archive -match '\.7z$') {
        throw "不支持 .7z，请先手动解压：$Archive"
    }
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("omni-tools-" + [guid]::NewGuid().ToString("N"))
    Expand-Archive -LiteralPath $Archive -DestinationPath $temp -Force
    $script:TempDirs += $temp
    $items = @(Get-ChildItem -LiteralPath $temp -Force)
    if ($items.Count -eq 1 -and $items[0].PSIsContainer) {
        return @{ Root = $items[0].FullName; Temp = $temp }
    }
    return @{ Root = $temp; Temp = $temp }
}

function Resolve-Payload([string]$Path, [string]$Label) {
    if (-not $Path) { return $null }
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "${Label} 路径不存在：$Path"
    }
    if (Test-Path -LiteralPath $Path -PathType Container) {
        return @{ Root = (Resolve-Path -LiteralPath $Path).Path; Temp = $null }
    }
    if ($DryRun) {
        Write-Step "would extract ${Label}: $Path（版本在解压后确定）"
        return $null
    }
    Write-Step "extracting ${Label}: $Path"
    return Expand-ToTemp $Path
}

function Get-ToolRoot([string]$Exe) {
    $bin = Split-Path -Parent $Exe
    if ((Split-Path -Leaf $bin) -ieq "bin") {
        return Split-Path -Parent $bin
    }
    return $bin
}

function Copy-Tree([string]$From, [string]$To, [string]$Label) {
    if ((Test-Path -LiteralPath $To) -and -not $Force) {
        Write-Step "skip $Label (already exists: $To；用 -Force 覆盖)"
        return
    }
    if ($DryRun) {
        Write-Step "would copy ${Label}: $From -> $To"
        return
    }
    Remove-ToolTarget $To
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    Copy-Item -Path (Join-Path $From '*') -Destination $To -Recurse -Force
    Write-Step "installed $Label -> $To"
}

function Clean-ToolsRoot {
    # 只删已知工具目录；README 和用户放在 tools/ 的 zip 压缩包保留。
    foreach ($name in @("cmake", "ninja", "llvm-embedded", "gcc-arm-none-eabi", "cmsis-toolbox")) {
        Remove-ToolTarget (Join-Path $ToolsRoot $name)
    }
}

function Find-LatestTool([string]$ExeName, [string]$VersionPattern) {
    $candidates = @(
        Get-ChildItem -LiteralPath $Source -Recurse -Depth 5 -Filter $ExeName -File -ErrorAction SilentlyContinue |
            ForEach-Object {
                $versionText = Invoke-Version $_.FullName $VersionPattern
                if ($versionText) {
                    [pscustomobject]@{
                        Root = (Get-ToolRoot $_.FullName)
                        Version = [version]$versionText
                    }
                }
            } |
            Sort-Object Version -Descending
    )
    if ($candidates.Count -gt 0) { return $candidates[0].Root }
    return $null
}

# ---------------------------------------------------------------------------
# 源目录与清理
# ---------------------------------------------------------------------------
if (-not $Source) {
    $Source = $env:OMNI_TOOLCHAIN_SOURCE
}
if (-not $Source) {
    # toolchains/ 只有 README 时不算“有工具”，否则会误抢 D:\ToolChain 的优先权。
    $toolchainItems = @(
        Get-ChildItem -LiteralPath $ToolchainRoot -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne "README.md" }
    )
    if ($toolchainItems.Count -gt 0) {
        $Source = $ToolchainRoot
    } elseif (Test-Path -LiteralPath "D:\ToolChain") {
        $Source = "D:\ToolChain"
    } else {
        $Source = $ToolsRoot
    }
}
if (-not (Test-Path -LiteralPath $Source)) {
    throw "工具源目录不存在：$Source（用 -Source 指定，或设置 OMNI_TOOLCHAIN_SOURCE）"
}
Write-Step "source: $Source"
if (Test-Path -LiteralPath $ToolchainRoot) {
    Write-Step "archive inbox: $ToolchainRoot（可选，不会打包）"
}
Ensure-ToolsRoot
if ($Clean) { Clean-ToolsRoot }

$payloads = @()

try {
    # -----------------------------------------------------------------------
    # CMake
    # -----------------------------------------------------------------------
    if (-not $Cmake) {
        $Cmake = Get-ChildItem -LiteralPath $Source -Directory -Filter "cmake-*-windows-*" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $Cmake) {
        $Cmake = Find-Archive @("cmake-*-windows-*.zip")
    }
    if ($Cmake) {
        $payload = Resolve-Payload $Cmake "cmake"
        if ($payload) {
            $payloads += @{
                Label = "cmake"
                Root = $payload.Root
                Target = (Join-Path $ToolsRoot "cmake")
            }
        }
    } else {
        Write-Step "skip cmake（没有 cmake-*-windows-* 目录或 zip）"
    }

    # -----------------------------------------------------------------------
    # Ninja
    # -----------------------------------------------------------------------
    $ninjaExe = $null
    $ninjaArchive = $null
    if ($Ninja) {
        if ($Ninja -match '\.zip$') { $ninjaArchive = $Ninja }
        elseif (Test-Path -LiteralPath $Ninja -PathType Container) { $ninjaExe = Find-ToolExe $Ninja "ninja.exe" }
        else { $ninjaExe = $Ninja }
    } else {
        $ninjaExe = Get-ChildItem -LiteralPath $Source -Recurse -Depth 4 -Filter "ninja.exe" -File -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
        if (-not $ninjaExe) {
            $cmd = Get-Command ninja -ErrorAction SilentlyContinue
            if ($cmd) { $ninjaExe = $cmd.Source }
        }
        if (-not $ninjaExe) {
            $ninjaArchive = Find-Archive @("*ninja*.zip")
        }
    }
    if ($ninjaArchive) {
        $payload = Resolve-Payload $ninjaArchive "ninja"
        if ($payload) { $ninjaExe = Find-ToolExe $payload.Root "ninja.exe" }
    }
    if ($ninjaExe) {
        $ninjaTarget = Join-Path $ToolsRoot "ninja"
        if ((Test-Path -LiteralPath $ninjaTarget) -and -not $Force) {
            Write-Step "skip ninja (already exists: $ninjaTarget；用 -Force 覆盖)"
        } elseif ($DryRun) {
            Write-Step "would install ninja: $ninjaExe -> $ninjaTarget"
        } else {
            Remove-ToolTarget $ninjaTarget
            New-Item -ItemType Directory -Path $ninjaTarget -Force | Out-Null
            Copy-Item -LiteralPath $ninjaExe -Destination (Join-Path $ninjaTarget "ninja.exe") -Force
            Write-Step "installed ninja -> $ninjaTarget"
        }
    } elseif (-not $ninjaArchive -or $DryRun) {
        Write-Step "skip ninja（没有 ninja.exe / ninja zip）"
    }

    # -----------------------------------------------------------------------
    # LLVM Embedded Toolchain
    # -----------------------------------------------------------------------
    if (-not $Llvm) {
        $Llvm = Find-LatestTool "clang.exe" 'clang version (\d+\.\d+\.\d+)'
    }
    if (-not $Llvm) {
        $Llvm = Find-Archive @("*llvm*embedded*.zip", "*llvm*.zip")
    }
    if ($Llvm) {
        $payload = Resolve-Payload $Llvm "llvm-embedded"
        if ($payload) {
            $clangExe = Find-ToolExe $payload.Root "clang.exe"
            if (-not $clangExe) { throw "LLVM 里找不到 bin\clang.exe：$($payload.Root)" }
            $version = Invoke-Version $clangExe 'clang version (\d+\.\d+\.\d+)'
            if (-not $version) { throw "无法确定 LLVM 版本：$clangExe" }
            $payloads += @{
                Label = "llvm-embedded $version"
                Root = (Get-ToolRoot $clangExe)
                Target = (Join-Path (Join-Path $ToolsRoot "llvm-embedded") $version)
            }
        }
    } else {
        Write-Step "skip llvm-embedded（没有 clang.exe / llvm zip）"
    }

    # -----------------------------------------------------------------------
    # Arm GNU Toolchain
    # -----------------------------------------------------------------------
    if (-not $Gcc) {
        $Gcc = Find-LatestTool "arm-none-eabi-gcc.exe" '(\d+\.\d+\.\d+)'
    }
    if (-not $Gcc) {
        $Gcc = Find-Archive @("*arm-none-eabi-gcc*.zip", "*arm-gnu-toolchain*.zip")
    }
    if ($Gcc) {
        $payload = Resolve-Payload $Gcc "gcc-arm-none-eabi"
        if ($payload) {
            $gccExe = Find-ToolExe $payload.Root "arm-none-eabi-gcc.exe"
            if (-not $gccExe) { throw "GCC 里找不到 bin\arm-none-eabi-gcc.exe：$($payload.Root)" }
            $version = Invoke-Version $gccExe '(\d+\.\d+\.\d+)'
            if (-not $version) { throw "无法确定 GCC 版本：$gccExe" }
            $payloads += @{
                Label = "gcc-arm-none-eabi $version"
                Root = (Get-ToolRoot $gccExe)
                Target = (Join-Path (Join-Path $ToolsRoot "gcc-arm-none-eabi") $version)
            }
        }
    } else {
        Write-Step "skip gcc-arm-none-eabi（没有 arm-none-eabi-gcc.exe / gcc zip）"
    }

    # -----------------------------------------------------------------------
    # CMSIS-Toolbox
    # -----------------------------------------------------------------------
    if (-not $CmsisToolbox) {
        $CmsisToolbox = Find-LatestTool "cbuild.exe" 'cbuild version (\d+\.\d+\.\d+)'
    }
    if (-not $CmsisToolbox) {
        $CmsisToolbox = Find-Archive @("*cmsis-toolbox*.zip")
    }
    if ($CmsisToolbox) {
        $payload = Resolve-Payload $CmsisToolbox "cmsis-toolbox"
        if ($payload) {
            $cbuildExe = Find-ToolExe $payload.Root "cbuild.exe"
            if (-not $cbuildExe) { throw "CMSIS-Toolbox 里找不到 bin\cbuild.exe：$($payload.Root)" }
            $version = Invoke-Version $cbuildExe 'cbuild version (\d+\.\d+\.\d+)'
            if (-not $version) { $version = Invoke-Version $cbuildExe '(\d+\.\d+\.\d+)' }
            if (-not $version) { throw "无法确定 CMSIS-Toolbox 版本：$cbuildExe" }
            $payloads += @{
                Label = "cmsis-toolbox $version"
                Root = (Get-ToolRoot $cbuildExe)
                Target = (Join-Path (Join-Path $ToolsRoot "cmsis-toolbox") $version)
            }
        }
    } else {
        Write-Step "skip cmsis-toolbox（没有 cbuild.exe / cmsis-toolbox zip）"
    }

    # -----------------------------------------------------------------------
    # 复制
    # -----------------------------------------------------------------------
    foreach ($payload in $payloads) {
        Copy-Tree -From $payload.Root -To $payload.Target -Label $payload.Label
    }
} finally {
    foreach ($temp in $script:TempDirs) {
        if ($temp -and (Test-Path -LiteralPath $temp)) {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Step "done。下一步：npm run package（或 build.ps1），electron-builder 会打包 tools/。"
Write-Step "查看解析结果：omni toolchain"
