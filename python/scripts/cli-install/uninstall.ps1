<#
.SYNOPSIS
    卸载 OMNI CLI（portable 版）。

.DESCRIPTION
    删除安装目录中的 omni.exe，并从当前用户的 PATH 中移除安装目录。
    不会修改系统 PATH，也不需要管理员权限。

.PARAMETER InstallDir
    安装目录。默认：%LOCALAPPDATA%\Programs\OMNI CLI\bin

.PARAMETER NoPath
    只删除文件，不修改用户 PATH（用于测试）。
#>
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\OMNI CLI\bin"),
    [switch]$NoPath
)

$ErrorActionPreference = "Stop"

$installFull = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd("\")
$driveRoot = [System.IO.Path]::GetPathRoot($installFull).TrimEnd("\")
if ($installFull -ieq $driveRoot) {
    throw "拒绝从磁盘根目录卸载：$InstallDir"
}

$target = Join-Path $InstallDir "omni.exe"
if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Force
    Write-Host "[uninstall] 已删除: $target" -ForegroundColor Green
} else {
    Write-Host "[uninstall] 未找到: $target" -ForegroundColor Yellow
}

if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($null -eq $userPath) { $userPath = "" }
    $normalized = $InstallDir.TrimEnd("\")
    $kept = @()
    foreach ($entry in ($userPath -split ";")) {
        if (-not $entry) { continue }
        if ($entry.TrimEnd("\") -ieq $normalized) { continue }
        $kept += $entry
    }
    $newPath = $kept -join ";"
    if ($newPath -ne $userPath) {
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "[uninstall] 已从用户 PATH 移除: $InstallDir" -ForegroundColor Green
    } else {
        Write-Host "[uninstall] 用户 PATH 未包含: $InstallDir" -ForegroundColor Yellow
    }
    $env:Path = ($env:Path -split ";" | Where-Object {
        $_ -and ($_.TrimEnd("\") -ine $normalized)
    }) -join ";"
}

if (Test-Path -LiteralPath $InstallDir) {
    $remaining = @(Get-ChildItem -LiteralPath $InstallDir -Force)
    if ($remaining.Count -eq 0) {
        Remove-Item -LiteralPath $InstallDir -Force
        $parent = Split-Path -Parent $InstallDir
        if ($parent -and (Test-Path -LiteralPath $parent)) {
            $parentItems = @(Get-ChildItem -LiteralPath $parent -Force)
            if ($parentItems.Count -eq 0) {
                Remove-Item -LiteralPath $parent -Force
            }
        }
    }
}

Write-Host "[uninstall] 完成。新开终端后 PATH 变更生效。" -ForegroundColor Green
