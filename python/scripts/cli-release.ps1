<#
.SYNOPSIS
    构建并打包独立的 OMNI CLI（Windows x64 portable）。

.DESCRIPTION
    只构建 CLI，不构建 Electron 前端/应用安装包：
      1. python build.py --cli-only   -> python/dist/omni.exe
      2. uv build                     -> python/dist/omni_cli-<version>-*.whl
      3. 组装 portable zip            -> python/dist/cli-release/omni-cli-<version>-win64.zip
      4. 生成 SHA256SUMS.txt

.PARAMETER OutputDir
    输出目录。默认：python/dist/cli-release

.PARAMETER Clean
    打包前清理输出目录。

.PARAMETER SkipBuild
    跳过 PyInstaller，直接使用已有的 python/dist/omni.exe。

.PARAMETER SkipWheel
    跳过 wheel 构建（zip 仍会生成）。

.PARAMETER NoZip
    只组装目录，不生成 zip。

.PARAMETER KeepStaging
    保留组装目录（默认成功后删除）。

.PARAMETER SignTool
    signtool.exe 路径；默认从 PATH 或 Windows SDK 查找。

.PARAMETER PfxPath
    .pfx/.p12 证书路径。

.PARAMETER PfxPassword
    证书密码。

.PARAMETER CertSha1
    Windows 证书库中的证书 SHA-1 指纹。

.PARAMETER CertSubject
    Windows 证书库中的证书主题名（子串匹配）。

.PARAMETER TimestampServer
    RFC3161 时间戳服务器，默认 http://timestamp.digicert.com

.PARAMETER RequireSigned
    要求 omni.exe 必须签名成功。
#>
param(
    [string]$OutputDir = "",
    [switch]$Clean,
    [switch]$SkipBuild,
    [switch]$SkipWheel,
    [switch]$NoZip,
    [switch]$KeepStaging,
    [string]$SignTool = "",
    [string]$PfxPath = "",
    [string]$PfxPassword = "",
    [string]$CertSha1 = "",
    [string]$CertSubject = "",
    [string]$TimestampServer = "http://timestamp.digicert.com",
    [switch]$RequireSigned
)

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$PyDir      = Split-Path -Parent $ScriptDir
$ProjectRoot = Split-Path -Parent $PyDir
$DistDir    = Join-Path $PyDir "dist"
$CliProj    = Join-Path $PyDir "omni_cli"
$TemplateDir = Join-Path $ScriptDir "cli-install"
$CliExe     = Join-Path $DistDir "omni.exe"

function Find-Python {
    $venv = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venv) { return $venv }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "找不到 Python。请先创建 .venv 或把 python 加入 PATH。"
}

function Get-CliVersion($py) {
    $code = "import sys; sys.path.insert(0, r'$PyDir'); from omni_cli import __version__; print(__version__)"
    $value = (& $py -c $code 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $value) {
        throw "无法读取 omni_cli 版本：$value"
    }
    if ($value -notmatch '^\d+\.\d+\.\d+$') {
        throw "omni_cli 版本格式异常：$value"
    }
    return $value
}

function Find-SignToolPath {
    if ($SignTool) {
        if (Test-Path -LiteralPath $SignTool) { return (Resolve-Path -LiteralPath $SignTool).Path }
        throw "找不到 signtool：$SignTool"
    }
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $roots = @()
    $x86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if ($x86) { $roots += (Join-Path $x86 "Windows Kits\10\bin") }
    if ($env:ProgramFiles) { $roots += (Join-Path $env:ProgramFiles "Windows Kits\10\bin") }
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $versions = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
                    Sort-Object Name -Descending
        foreach ($v in $versions) {
            $candidate = Join-Path $v.FullName "x64\signtool.exe"
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return $null
}

function Invoke-SignFile($signTool, $path) {
    $signArgs = @("sign", "/fd", "SHA256", "/td", "SHA256", "/tr", $TimestampServer)
    if ($PfxPath) {
        $resolved = (Resolve-Path -LiteralPath $PfxPath).Path
        $signArgs += @("/f", $resolved)
        if ($PfxPassword) { $signArgs += @("/p", $PfxPassword) }
    } elseif ($CertSha1) {
        $signArgs += @("/sha1", $CertSha1)
    } elseif ($CertSubject) {
        $signArgs += @("/n", $CertSubject)
    } else {
        return $false
    }
    $signArgs += $path
    & $signTool @signArgs
    if ($LASTEXITCODE -ne 0) {
        throw "签名失败（退出码 $LASTEXITCODE）：$path"
    }
    return $true
}

$py = Find-Python
$version = Get-CliVersion $py
$versionTag = "omni-cli-$version-win64"
$releaseDir = if ($OutputDir) { $OutputDir } else { Join-Path $DistDir "cli-release" }

# -Clean 只允许删除专用输出目录，避免误删项目根、python/ 或 dist/。
$releaseFull = [System.IO.Path]::GetFullPath($releaseDir).TrimEnd("\")
$driveRoot = [System.IO.Path]::GetPathRoot($releaseFull).TrimEnd("\")
if ($releaseFull -ieq $driveRoot) {
    throw "拒绝把 -OutputDir 指向磁盘根目录：$releaseDir"
}
foreach ($protected in @($ProjectRoot, $PyDir, $DistDir)) {
    if ($releaseFull -ieq ([System.IO.Path]::GetFullPath($protected).TrimEnd("\"))) {
        throw "拒绝把 -OutputDir 指向受保护目录：$releaseDir"
    }
}

if ($Clean -and (Test-Path -LiteralPath $releaseDir)) {
    Remove-Item -LiteralPath $releaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
$staleSums = Join-Path $releaseDir "SHA256SUMS.txt"
if (Test-Path -LiteralPath $staleSums) { Remove-Item -LiteralPath $staleSums -Force }

Write-Host "[cli-release] OMNI CLI $version" -ForegroundColor Cyan
Write-Host "[cli-release] 输出: $releaseDir" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. Build CLI exe
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host "[1/4] python build.py --cli-only" -ForegroundColor Yellow
    & $py (Join-Path $PyDir "build.py") --cli-only
    if ($LASTEXITCODE -ne 0) { throw "CLI 构建失败" }
} else {
    Write-Host "[1/4] 跳过 CLI 构建（-SkipBuild）" -ForegroundColor DarkGray
}
if (-not (Test-Path -LiteralPath $CliExe)) {
    throw "找不到 CLI：$CliExe"
}
$cliSizeMB = [math]::Round((Get-Item -LiteralPath $CliExe).Length / 1MB, 1)
$exeVersion = (& $CliExe --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "omni.exe 无法运行：$exeVersion" }
if ($exeVersion -notmatch [regex]::Escape($version)) {
    throw "omni.exe 版本与包版本不一致：$exeVersion（期望 $version）"
}
Write-Host "[cli-release] omni.exe: $CliExe ($cliSizeMB MB, $exeVersion)" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 2. Build wheel
# ---------------------------------------------------------------------------
$wheel = $null
if (-not $SkipWheel) {
    $uv = (Get-Command uv -ErrorAction SilentlyContinue)
    if (-not $uv) { throw "找不到 uv；请安装 uv 或加 -SkipWheel" }

    # 清理 setuptools 的 build/lib、egg-info 和 __pycache__，
    # 避免把 .pyc 或旧文件带进 wheel。
    foreach ($cache in @(
        (Join-Path $CliProj "build"),
        (Join-Path $CliProj "omni_cli.egg-info"),
        (Join-Path $CliProj "__pycache__"),
        (Join-Path $CliProj "commands\__pycache__"),
        (Join-Path $CliProj "project\__pycache__")
    )) {
        if (Test-Path -LiteralPath $cache) { Remove-Item -LiteralPath $cache -Recurse -Force }
    }
    Get-ChildItem -LiteralPath $DistDir -Filter "omni_cli-$version-*.whl" -File -ErrorAction SilentlyContinue |
        Remove-Item -Force

    Write-Host "[2/4] uv build --wheel" -ForegroundColor Yellow
    & $uv.Source build $CliProj --wheel --out-dir $DistDir
    if ($LASTEXITCODE -ne 0) { throw "wheel 构建失败" }
    $wheel = Get-ChildItem -LiteralPath $DistDir -Filter "omni_cli-$version-*.whl" -File |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $wheel) { throw "找不到 omni_cli-$version-*.whl" }
    Copy-Item -LiteralPath $wheel.FullName -Destination $releaseDir -Force
    Write-Host "[cli-release] wheel: $($wheel.Name)" -ForegroundColor Green
} else {
    Write-Host "[2/4] 跳过 wheel 构建（-SkipWheel）" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# 3. Sign omni.exe (optional)
# ---------------------------------------------------------------------------
$signingRequested = [bool]($PfxPath -or $CertSha1 -or $CertSubject)
if ($signingRequested) {
    $signTool = Find-SignToolPath
    if (-not $signTool) { throw "找不到 signtool；请用 -SignTool 指定路径" }
    Write-Host "[3/4] 签名 omni.exe" -ForegroundColor Yellow
    Invoke-SignFile $signTool $CliExe | Out-Null
    $sig = Get-AuthenticodeSignature -LiteralPath $CliExe
    if ($sig.Status -ne "Valid") {
        throw "omni.exe 签名校验失败：$($sig.Status) $($sig.StatusMessage)"
    }
    Write-Host "[cli-release] 签名有效：$($sig.SignerCertificate.Subject)" -ForegroundColor Green
} elseif ($RequireSigned) {
    throw "指定了 -RequireSigned，但没有提供 -PfxPath / -CertSha1 / -CertSubject"
} else {
    Write-Host "[3/4] 未配置签名，omni.exe 将未签名（Windows 可能提示未知发布者）" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 4. Stage + zip
# ---------------------------------------------------------------------------
$stage = Join-Path $releaseDir $versionTag
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Copy-Item -LiteralPath $CliExe -Destination (Join-Path $stage "omni.exe") -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "LICENSE") -Destination (Join-Path $stage "LICENSE") -Force

$readmeTemplate = Join-Path $TemplateDir "README.md"
$readmeText = [System.IO.File]::ReadAllText($readmeTemplate)
$readmeText = $readmeText.Replace("{{VERSION}}", $version)
[System.IO.File]::WriteAllText((Join-Path $stage "README.md"), $readmeText, (New-Object System.Text.UTF8Encoding($false)))

Copy-Item -LiteralPath (Join-Path $TemplateDir "install.ps1") -Destination (Join-Path $stage "install.ps1") -Force
Copy-Item -LiteralPath (Join-Path $TemplateDir "uninstall.ps1") -Destination (Join-Path $stage "uninstall.ps1") -Force

$hashLines = @()
foreach ($name in @("omni.exe", "README.md", "LICENSE", "install.ps1", "uninstall.ps1")) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $stage $name) -Algorithm SHA256).Hash
    $hashLines += "$hash  $name"
}
[System.IO.File]::WriteAllLines((Join-Path $stage "SHA256SUMS.txt"), $hashLines, (New-Object System.Text.UTF8Encoding($false)))

$zipPath = Join-Path $releaseDir "$versionTag.zip"
if (-not $NoZip) {
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Write-Host "[4/4] 生成 portable zip" -ForegroundColor Yellow
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -Force
    Write-Host "[cli-release] zip: $zipPath" -ForegroundColor Green
} else {
    Write-Host "[4/4] 跳过 zip（-NoZip）" -ForegroundColor DarkGray
}

# Release-level checksums for zip/wheel
$artifacts = @()
if (Test-Path -LiteralPath $zipPath) { $artifacts += (Get-Item -LiteralPath $zipPath) }
if ($wheel -and (Test-Path -LiteralPath (Join-Path $releaseDir $wheel.Name))) {
    $artifacts += (Get-Item -LiteralPath (Join-Path $releaseDir $wheel.Name))
}
if ($artifacts.Count -gt 0) {
    $releaseLines = @()
    foreach ($artifact in $artifacts) {
        $hash = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash
        $releaseLines += "$hash  $($artifact.Name)"
    }
    [System.IO.File]::WriteAllLines((Join-Path $releaseDir "SHA256SUMS.txt"), $releaseLines, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not $KeepStaging) {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

Write-Host ""
Write-Host "完成。发布物：" -ForegroundColor Green
Get-ChildItem -LiteralPath $releaseDir -File | ForEach-Object {
    $mb = [math]::Round($_.Length / 1MB, 2)
    Write-Host ("  {0}  ({1} MB)" -f $_.Name, $mb) -ForegroundColor White
}
