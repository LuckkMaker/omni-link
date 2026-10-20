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
.PARAMETER PfxPath
    代码签名证书（.pfx / .p12）。不填时读取 WIN_CSC_LINK / CSC_LINK 环境变量
.PARAMETER PfxPassword
    .pfx 私钥密码；也可以改用 WIN_CSC_KEY_PASSWORD 环境变量（推荐，避免密码留在命令历史里）
.PARAMETER CertSha1
    使用 Windows 证书库中证书的 SHA-1 指纹（EV 硬件令牌只能走这种方式）
.PARAMETER CertSubject
    使用 Windows 证书库中证书主题名（子串匹配），与 -CertSha1 二选一
.PARAMETER TimestampServer
    RFC3161 时间戳服务器，默认 http://timestamp.digicert.com
.PARAMETER RequireSigned
    要求产物必须已签名：未配置签名或签名失败时直接以非零退出码结束（适合 CI）
.PARAMETER VerifyOnly
    只检查 release/ 下现有产物的签名状态，不执行任何构建
.EXAMPLE
    .\build.ps1
    .\build.ps1 -Clean
    .\build.ps1 -Python "C:\Python312\python.exe"
    .\build.ps1 -SkipBackend
    .\build.ps1 -PfxPath .\certs\omni.pfx -PfxPassword "******"
    .\build.ps1 -CertSha1 8F1A2B... -RequireSigned
#>
param(
    [switch]$Clean,
    [string]$Python,
    [switch]$SkipBackend,
    [switch]$SkipFrontend,
    [string]$PfxPath,
    [string]$PfxPassword,
    [string]$CertSha1,
    [string]$CertSubject,
    [string]$TimestampServer,
    [switch]$RequireSigned,
    [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# package.json 是 UTF-8 且没有 BOM；Windows PowerShell 5.1 默认按系统 ANSI 码页
# （中文系统为 GBK）读取会乱码，导致 ConvertFrom-Json 解析失败，故显式指定编码。
function Get-BuildConfig {
    return (Get-Content (Join-Path $ProjectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).build
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  OMNI Link Build Script" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# 检查 release/ 产物的签名状态（打包结束时或 -VerifyOnly 调用）
#
# electron-builder 会签名安装包、应用主程序，以及 extraResources 里的 .exe；
# 但不会签名 Python 后端目录里的 .dll/.pyd（默认 signExts 只包含 .exe）。
# ---------------------------------------------------------------------------
function Test-ReleaseArtifacts {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseDir,
        [string]$ProductName,
        [string]$SigningMode = "none",
        [string]$InstallerPath
    )

    $unpackedDir = Join-Path $ReleaseDir "win-unpacked"
    $targets = @()
    if ($InstallerPath -and (Test-Path -LiteralPath $InstallerPath)) { $targets += $InstallerPath }
    if ($ProductName) {
        $appExe = Join-Path $unpackedDir "$ProductName.exe"
        if (Test-Path -LiteralPath $appExe) { $targets += $appExe }
    }
    foreach ($relative in @("resources\python\omni.exe", "resources\python\omni-backend.exe")) {
        $candidate = Join-Path $unpackedDir $relative
        if (Test-Path -LiteralPath $candidate) { $targets += $candidate }
    }

    $unsignedFiles = @()
    $untrustedFiles = @()

    if ($targets.Count -gt 0) {
        Write-Host ""
        Write-Host "[build] Signature status:" -ForegroundColor White
        foreach ($target in $targets) {
            $signature = Get-AuthenticodeSignature -LiteralPath $target
            $signer = "-"
            if ($signature.SignerCertificate) {
                try {
                    $signer = $signature.SignerCertificate.GetNameInfo(
                        [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
                }
                catch {
                    $signer = $signature.SignerCertificate.Subject
                }
            }
            $shown = $target
            if ($shown.StartsWith($ReleaseDir, [System.StringComparison]::OrdinalIgnoreCase)) {
                $shown = $shown.Substring($ReleaseDir.Length).TrimStart('\')
            }
            if ($signature.Status -eq "Valid") { $color = "Green" }
            elseif ($signature.Status -eq "NotSigned") { $color = "Yellow"; $unsignedFiles += $shown }
            else { $color = "DarkYellow"; $untrustedFiles += $shown }
            Write-Host ("  {0,-58} {1,-12} {2}" -f $shown, $signature.Status, $signer) -ForegroundColor $color
        }
    }

    if ($unsignedFiles.Count -gt 0) {
        if ($SigningMode -eq "none") {
            Write-Host ""
            Write-Host "[build] 安装包未签名：Windows 安装时会提示「未知发布者 / 有风险」" -ForegroundColor Yellow
            Write-Host "        签名后 UAC 与文件属性会显示发布者名称；SmartScreen 仍会随下载量逐步建立声誉。" -ForegroundColor DarkGray
            Write-Host "        配置方式见 docs/tech/code-signing.md（支持 pfx / 证书库 / Azure 云签名）" -ForegroundColor DarkGray
            if ($InstallerPath -and (Test-Path -LiteralPath $InstallerPath)) {
                $installerHash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash
                Write-Host "        安装包 SHA-256: $installerHash" -ForegroundColor DarkGray
            }
            try {
                $availableCerts = @()
                foreach ($store in @("Cert:\CurrentUser\My", "Cert:\LocalMachine\My")) {
                    $availableCerts += Get-ChildItem $store -CodeSigningCert -ErrorAction SilentlyContinue |
                        Where-Object { $_.NotAfter -gt (Get-Date) }
                }
                if ($availableCerts.Count -gt 0) {
                    Write-Host "        本机可用的代码签名证书（用 -CertSha1 指定）：" -ForegroundColor DarkGray
                    $availableCerts | Select-Object -First 5 | ForEach-Object {
                        Write-Host ("          {0} | sha1={1} | 有效期至 {2:yyyy-MM-dd}" -f `
                            $_.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false), `
                            $_.Thumbprint, $_.NotAfter) -ForegroundColor DarkGray
                    }
                }
            }
            catch {
                # 证书库查询失败不影响构建结果
            }
        }
        else {
            Write-Host ""
            Write-Host "[build] ERROR: 已配置代码签名，但以下文件仍未签名：" -ForegroundColor Red
            $unsignedFiles | ForEach-Object { Write-Host "          $_" -ForegroundColor Red }
        }
    }

    if ($untrustedFiles.Count -gt 0) {
        Write-Host ""
        Write-Host "[build] WARNING: 签名存在，但证书链无法在本机验证（自签名证书，或缺少根/中间证书）。" -ForegroundColor Yellow
        Write-Host "        对外分发请使用受信任 CA 签发的证书，否则用户侧仍会看到安全警告。" -ForegroundColor DarkGray
    }

    return [pscustomobject]@{
        Unsigned  = $unsignedFiles
        Untrusted = $untrustedFiles
    }
}

# ---------------------------------------------------------------------------
# -VerifyOnly：只校验现有产物的签名，不构建
# ---------------------------------------------------------------------------
if ($VerifyOnly) {
    Write-Host "--- Verify release signatures ---" -ForegroundColor Yellow
    $releaseDir = Join-Path $ProjectRoot "release"
    $productName = (Get-BuildConfig).productName
    $installer = Get-ChildItem (Join-Path $releaseDir "*Setup*.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
    $installerPath = if ($installer) { $installer.FullName } else { $null }
    $verification = Test-ReleaseArtifacts -ReleaseDir $releaseDir -ProductName $productName -InstallerPath $installerPath
    Write-Host ""
    if ($verification.Unsigned.Count -eq 0 -and $verification.Untrusted.Count -eq 0) {
        Write-Host "[verify] 所有产物均已正确签名。" -ForegroundColor Green
        exit 0
    }
    Write-Host "[verify] 存在未签名或无法验证的产物。" -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------------------
# Code signing configuration
#
# 未签名的安装包在 Windows 上会出现“未知发布者 / 有风险”：
#   · UAC / 文件属性里发布者显示为“未知”
#   · SmartScreen 显示“Windows 已保护你的电脑”，要“更多信息 -> 仍要运行”
# 这不是打包错误，而是 exe 缺少 Authenticode 签名，系统无法确认发布者。
#
# 配置方式（优先级从高到低）：
#   1. -PfxPath / -PfxPassword    .pfx/.p12 证书文件（OV 证书，可导出私钥）
#   2. WIN_CSC_LINK 环境变量      同上，适合 CI（配合 WIN_CSC_KEY_PASSWORD）
#   3. -CertSha1 / -CertSubject   Windows 证书库中的证书（EV 硬件令牌只能这样用）
# 另外，若 package.json 的 build.win.azureSignOptions 已配置（并注入 AZURE_* 环境
# 变量），electron-builder 会自动走 Azure 云签名。
# 详细说明见 docs/tech/code-signing.md
# ---------------------------------------------------------------------------
$ebArgs = @("--win", "--publish", "never")
$signingMode = "none"

if ($PfxPath) {
    if (-not (Test-Path -LiteralPath $PfxPath)) {
        Write-Host "ERROR: 找不到证书文件：$PfxPath" -ForegroundColor Red
        exit 1
    }
    # electron-builder 通过 WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD 自动签名，
    # 包括安装包、应用主程序以及 extraResources 里的 .exe（Python 后端、CLI）。
    $env:WIN_CSC_LINK = (Resolve-Path -LiteralPath $PfxPath).Path
    if ($PfxPassword) { $env:WIN_CSC_KEY_PASSWORD = $PfxPassword }
    $signingMode = "pfx"
}
elseif ($env:WIN_CSC_LINK -or $env:CSC_LINK) {
    $signingMode = "pfx (env)"
}
elseif ($CertSha1) {
    $ebArgs += "--config.win.signtoolOptions.certificateSha1=$CertSha1"
    $signingMode = "store"
}
elseif ($CertSubject) {
    $ebArgs += "--config.win.signtoolOptions.certificateSubjectName=$CertSubject"
    $signingMode = "store"
}
else {
    $pkgBuild = Get-BuildConfig
    if ($pkgBuild.win -and $pkgBuild.win.azureSignOptions) {
        $signingMode = "azure"
    }
}

if ($TimestampServer) {
    $ebArgs += "--config.win.signtoolOptions.rfc3161TimeStampServer=$TimestampServer"
    $ebArgs += "--config.win.signtoolOptions.timeStampServer=$TimestampServer"
}

if ($RequireSigned -and $signingMode -eq "none") {
    Write-Host "ERROR: 指定了 -RequireSigned，但没有找到任何签名配置。" -ForegroundColor Red
    Write-Host "  示例：.\build.ps1 -PfxPath .\certs\omni.pfx -PfxPassword <密码>" -ForegroundColor Yellow
    exit 1
}
if ($signingMode -ne "none") {
    Write-Host "[build] Code signing: enabled ($signingMode)" -ForegroundColor Green
}
else {
    Write-Host "[build] Code signing: disabled — 安装包将未签名（Windows 会提示未知发布者）" -ForegroundColor Yellow
}

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

    # Verify CLI exe exists (随安装包分发，安装后可直接在终端使用 omni)
    $cliExe = "$ProjectRoot\python\dist\omni.exe"
    if (-not (Test-Path $cliExe)) {
        Write-Host "ERROR: CLI executable not found at '$cliExe'" -ForegroundColor Red
        exit 1
    }
    $cliSizeMB = [math]::Round((Get-Item $cliExe).Length / 1MB, 1)
    Write-Host "[build] CLI exe: $cliExe ($cliSizeMB MB)" -ForegroundColor Green
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

    # 代码签名参数（$ebArgs / $signingMode）已在 Step 1 之前解析，这里直接传给 electron-builder。

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

    # --publish never：CI 环境（如设置了 CI / GITHUB_ACTIONS 变量）下 electron-builder
    # 默认会触发隐式发布到 GitHub 并因缺少 GH_TOKEN 报错（安装包其实已生成，但退出码为 1）。
    # 这里只产出本地安装包，明确禁用发布。
    npx electron-builder @ebArgs 2>&1 | Tee-Object -Variable buildOutput
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

    # -----------------------------------------------------------------------
    # 校验签名状态（安装包 / 应用主程序 / 内附的 Python 后端与 CLI）
    # -----------------------------------------------------------------------
    $productName = (Get-BuildConfig).productName
    $verification = Test-ReleaseArtifacts -ReleaseDir $releaseDir -ProductName $productName `
        -SigningMode $signingMode -InstallerPath $(if ($installer) { $installer.FullName } else { $null })
    if ($verification.Unsigned.Count -gt 0 -and $signingMode -ne "none") {
        exit 1
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
