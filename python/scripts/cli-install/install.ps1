<#
.SYNOPSIS
    安装 OMNI CLI（portable 版，按用户安装，无需管理员权限）。

.DESCRIPTION
    把同目录下的 omni.exe 复制到用户目录，并把安装目录加入当前用户的 PATH。
    不会修改系统 PATH，也不需要管理员权限。

.PARAMETER InstallDir
    安装目录。默认：%LOCALAPPDATA%\Programs\OMNI CLI\bin

.PARAMETER NoPath
    只复制文件，不修改用户 PATH（用于测试或自定义 PATH）。

.PARAMETER Force
    已存在时直接覆盖；不指定时也会覆盖（保留此参数用于兼容）。
#>
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\OMNI CLI\bin"),
    [switch]$NoPath,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$installFull = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd("\")
$driveRoot = [System.IO.Path]::GetPathRoot($installFull).TrimEnd("\")
if ($installFull -ieq $driveRoot) {
    throw "拒绝安装到磁盘根目录：$InstallDir"
}

$source = Join-Path $PSScriptRoot "omni.exe"
if (-not (Test-Path -LiteralPath $source)) {
    throw "安装包不完整：找不到 $source"
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$target = Join-Path $InstallDir "omni.exe"
Copy-Item -LiteralPath $source -Destination $target -Force

Write-Host "[install] 已复制: $target" -ForegroundColor Green

if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($null -eq $userPath) { $userPath = "" }
    $entries = @($userPath -split ";" | Where-Object { $_ -and $_.Trim() })
    $normalized = $InstallDir.TrimEnd("\")
    $exists = $false
    foreach ($entry in $entries) {
        if ($entry.TrimEnd("\") -ieq $normalized) { $exists = $true; break }
    }
    if (-not $exists) {
        $newPath = (@($entries) + $InstallDir) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "[install] 已加入用户 PATH: $InstallDir" -ForegroundColor Green
        Write-Host "[install] 新开一个终端后生效（当前会话已临时生效）" -ForegroundColor Yellow
    } else {
        Write-Host "[install] 用户 PATH 已包含: $InstallDir" -ForegroundColor Green
    }
    $env:Path = "$InstallDir;$env:Path"
}

& $target --version
if ($LASTEXITCODE -ne 0) {
    throw "omni.exe 自检失败，退出码 $LASTEXITCODE"
}

Write-Host ""
Write-Host "OMNI CLI 安装完成。" -ForegroundColor Green
Write-Host "  omni --version" -ForegroundColor White
Write-Host "  omni project config --target stm32f407ig" -ForegroundColor White
Write-Host ""
Write-Host "如果构建脚本仍使用旧的 OMNI_CLI 环境变量，请把它指向：" -ForegroundColor Yellow
Write-Host "  $target" -ForegroundColor White
