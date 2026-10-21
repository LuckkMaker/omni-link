# OMNI CLI 冒烟 / 集成测试
# 用法：
#   .\cli-smoke.ps1                      # 只测只读/离线子集（安全）
#   .\cli-smoke.ps1 -Firmware .\app.hex  # 追加破坏性 program/erase 回环（需确认板子可擦除）
#   .\cli-smoke.ps1 -Elf .\app.axf       # 追加调试控制段（需已连接探针）
#   .\cli-smoke.ps1 -Rtt                 # 追加 RTT 启停与 rtt read（固件需初始化 SEGGER RTT）
#   .\cli-smoke.ps1 -UseInstalled         # 改用 venv 里已安装的 omni.exe（wheel 安装后）
param(
    [string]$Firmware = "",          # 固件路径；提供后执行 flash program/erase 回环
    [string]$Elf      = "",          # ELF/AXF 路径；提供后执行 debug 命令组（ELF/断点/寄存器/内存）
    [string]$Target   = "stm32f407xg",
    [string]$Uid      = "",
    [int]$Port        = 57123,
    [switch]$Rtt,                    # 追加 RTT 上行读取段
    [switch]$UseInstalled            # true=用已安装的 omni；false=用源码 python -m omni_cli
)

$ErrorActionPreference = "Continue"
$py  = "D:\workspace\embedded\omni-link\.venv\Scripts\python.exe"
$cwd = "D:\workspace\embedded\omni-link\python"

# 本轮“预期失败/编码”检查的失败计数（脚本末尾汇总并影响退出码）
$script:encodingFailures = 0
$script:expectFailures = 0

# CLI 调用方式：安装态直接用 omni.exe，开发态用 python -m omni_cli
if ($UseInstalled) {
    $cliExe = "D:\workspace\embedded\omni-link\.venv\Scripts\omni.exe"
    $cliPrefix = @()
    Write-Host "使用已安装的 omni.exe" -ForegroundColor Magenta
} else {
    $cliExe = $py
    $cliPrefix = @("-m", "omni_cli")
}

function Run([string]$Name, [string[]]$ArgsList) {
    Write-Host ""
    Write-Host ("===== " + $Name + " =====") -ForegroundColor Cyan
    & $cliExe @cliPrefix @ArgsList
    Write-Host ("exit=$LASTEXITCODE")
}

# 预期失败：必须返回非 0（用于验证“缺 --target 立即失败”这类修复）
function RunExpectFail([string]$Name, [string[]]$ArgsList) {
    Write-Host ""
    Write-Host ("===== " + $Name + "（预期失败）=====") -ForegroundColor Cyan
    # 用 Start-Process 分离重定向：PS 5.1 会把原生 stderr 包成 NativeCommandError
    # 写进错误流，直接 2>&1 / 2> 都会刷一堆红色噪声，看起来像用例失败。
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath $cliExe -ArgumentList ($cliPrefix + $ArgsList) -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $code = $proc.ExitCode
    $text = ((Get-Content -Path $outFile -Raw -Encoding UTF8) + (Get-Content -Path $errFile -Raw -Encoding UTF8))
    Remove-Item -Path $outFile, $errFile -Force -ErrorAction SilentlyContinue
    if ($text) { Write-Host $text.TrimEnd() }
    if ($code -eq 0) {
        Write-Host "  UNEXPECTED SUCCESS: 本应失败却返回 0" -ForegroundColor Red
        $script:expectFailures++
    } else {
        Write-Host "  expected failure, exit=$code" -ForegroundColor DarkGray
    }
}

# 中文输出不应出现 U+FFFD（P1-4）。PowerShell 7 默认按 UTF-8 解码子进程输出。
function CheckNoMojibake([string]$Name, [string[]]$ArgsList) {
    $out = & $cliExe @cliPrefix @ArgsList 2>&1 | Out-String
    $bad = ([regex]::Matches($out, [char]0xFFFD)).Count
    if ($bad -eq 0) {
        Write-Host ("  [编码] " + $Name + " OK（无 U+FFFD）") -ForegroundColor Green
    } else {
        Write-Host ("  [编码] " + $Name + " FAIL：U+FFFD=" + $bad) -ForegroundColor Red
        $script:encodingFailures++
    }
}

# ── A. 自检（无需后端/硬件）─────────────────────────────
Write-Host "## A. 自检" -ForegroundColor Green
Run "版本" @("--version")
Run "commander exec 缺参引导" @("commander", "exec")
CheckNoMojibake "backend -h" @("backend", "-h")
CheckNoMojibake "probe connect -h" @("probe", "connect", "-h")
CheckNoMojibake "rtt read -h" @("rtt", "read", "-h")
CheckNoMojibake "project -h" @("project", "-h")
CheckNoMojibake "project config -h" @("project", "config", "-h")
RunExpectFail "probe connect 缺 --target" @("probe", "connect", "DUMMY")

# ── B. 拉起常驻后端（脚本进程存活期间保持）─────────────
Write-Host "`n## B. 启动常驻后端 port=$Port" -ForegroundColor Green
$p = Start-Process -FilePath $py -ArgumentList @("server.py","--port",$Port) -WorkingDirectory $cwd -PassThru
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    if (& $py -c "from omni_cli.client import reachable; print(reachable($Port))" -match "True") { $ready = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { Write-Host "后端未就绪，终止" -ForegroundColor Red; exit 1 }

# ── C. 探针 / 目标（离线+枚举）─────────────────────────
Write-Host "`n## C. 探针与目标型号" -ForegroundColor Green
Run "probe list" @("probe","list","--backend-port",$Port)
Run "target list (stm32f4)" @("target","list","--search","stm32f4","--limit","8","--backend-port",$Port)
Run "target info" @("target","info",$Target,"--backend-port",$Port)

# ── D. Commander 离线命令 ──────────────────────────────
Write-Host "`n## D. Commander 离线" -ForegroundColor Green
# 注意：commander 子命令用 REMAINDER 捕获命令参数，全局选项须放在命令之前
Run "commander exec list" @("commander","exec","--backend-port",$Port,"list")

# ── E. 连接 + Commander 在线 + Flash 只读 ──────────────
if (-not $Uid) {
    $listOut = & $cliExe @cliPrefix probe list --backend-port $Port --json | Out-String
    if ($listOut -notmatch '"probes"\s*:\s*\[\]') { $Uid = ($listOut | ConvertFrom-Json).probes[0].uid }
}
Write-Host "`n## E. 使用 uid=$Uid" -ForegroundColor Green
if ($Uid) {
Run "connect" @("probe","connect",$Uid,"--target",$Target,"--connect-mode","attach","--backend-port",$Port)
Run "commander status" @("commander","exec","--uid",$Uid,"--backend-port",$Port,"status")
Run "commander read32 0x080000C0" @("commander","exec","--uid",$Uid,"--backend-port",$Port,"read32","0x080000C0","4")
Run "flash blank-check(64B)" @("flash","blank-check","--addr","0x08000000","--size","64","--uid",$Uid,"--backend-port",$Port)
Run "flash read(range 64B,json)" @("flash","read","--type","range","--addr","0x08000000","--size","64","--uid",$Uid,"--backend-port",$Port,"--json")
Run "rtt status(kv)" @("rtt","status","--uid",$Uid,"--backend-port",$Port)
}
if (-not $Uid) {
    Write-Host "（无探针时跳过 E/H 硬件段）" -ForegroundColor DarkGray
}

# ── G. 设备应用库（离线，无需硬件）─────────────────────
Write-Host "`n## G. 设备应用库" -ForegroundColor Green
Run "device summary" @("device","summary","--backend-port",$Port)
Run "device list(search G32)" @("device","list","--search","G32","--limit","12","--backend-port",$Port)
Run "device info G32F463XC" @("device","info","g32f463xc","--backend-port",$Port)
Run "device info 不存在(应 404)" @("device","info","no-such-device-xyz","--backend-port",$Port)

# ── H. RTT（需已连接探针）──────────────────────────────
if ($Uid) {
Write-Host "`n## H. RTT" -ForegroundColor Green
Run "rtt device status" @("rtt","device","status","--uid",$Uid,"--backend-port",$Port)
Run "rtt device halt" @("rtt","device","halt","--uid",$Uid,"--backend-port",$Port)
Run "rtt device run" @("rtt","device","run","--uid",$Uid,"--backend-port",$Port)
if ($Rtt) {
    Run "rtt start" @("rtt","start","--uid",$Uid,"--backend-port",$Port)
    Start-Sleep -Milliseconds 800
    Run "rtt status(含缓存统计)" @("rtt","status","--uid",$Uid,"--backend-port",$Port)
    Run "rtt read --json" @("rtt","read","--uid",$Uid,"--backend-port",$Port,"--json")
    Run "rtt read --follow --duration 2" @("rtt","read","--uid",$Uid,"--backend-port",$Port,"--follow","--duration","2")
    Run "rtt stop" @("rtt","stop","--uid",$Uid,"--backend-port",$Port)
}
}

# Commander 尾部全局选项（P3-2）：--timeout 必须被前移，不能当成命令参数
if ($Uid) {
    Run "commander exec 尾部 --timeout" @("commander","exec","--backend-port",$Port,"read32","0x08000000","4","--timeout","15")
} else {
    Run "commander exec 尾部 --timeout(离线)" @("commander","exec","--backend-port",$Port,"list","--timeout","15")
}

# ── F. 破坏性回环（仅当提供固件时）────────────────────
if ($Firmware) {
    if (-not (Test-Path $Firmware)) { Write-Host "固件不存在: $Firmware" -ForegroundColor Red }
    else {
        $abs = (Resolve-Path $Firmware).Path
        Write-Host "`n## F. 破坏性回环（会擦除/重写板载 Flash！）" -ForegroundColor Yellow
        Run "flash program" @("flash","program",$abs,"--uid",$Uid,"--backend-port",$Port)
        Run "flash verify" @("flash","verify",$abs,"--uid",$Uid,"--backend-port",$Port)
        # P3-1：verify 响应必须是 bytes_verified，不能出现 bytes_written
        $verifyJson = & $cliExe @cliPrefix flash verify $abs --uid $Uid --backend-port $Port --json 2>$null | Out-String
        if ($verifyJson -match '"bytes_written"') {
            Write-Host "  [verify 字段] FAIL：仍返回 bytes_written" -ForegroundColor Red
            $script:expectFailures++
        } elseif ($verifyJson -match '"bytes_verified"') {
            Write-Host "  [verify 字段] OK：返回 bytes_verified" -ForegroundColor Green
        } else {
            Write-Host "  [verify 字段] WARN：未找到 bytes_verified（固件可能为空？）" -ForegroundColor Yellow
        }
        Run "commander cmp(固件比较)" @("commander","exec","--uid",$Uid,"--backend-port",$Port,"cmp","0x08000000",(Split-Path $abs -Leaf))
        Run "flash blank-check(after program)" @("flash","blank-check","--uid",$Uid,"--backend-port",$Port)
        # 擦除：默认 180s；响应必须是 bytes_erased（不能出现 bytes_written: 0），并带 rtt_stopped
        $eraseJson = & $cliExe @cliPrefix flash erase --type chip --uid $Uid --backend-port $Port --timeout 180 --json 2>$null | Out-String
        Write-Host ""
        Write-Host "===== flash erase(chip,json) =====" -ForegroundColor Cyan
        Write-Host $eraseJson
        if ($eraseJson -match '"bytes_written"') {
            Write-Host "  [erase 字段] FAIL：仍返回 bytes_written" -ForegroundColor Red
            $script:expectFailures++
        } elseif ($eraseJson -match '"bytes_erased"') {
            Write-Host "  [erase 字段] OK：返回 bytes_erased" -ForegroundColor Green
        } else {
            Write-Host "  [erase 字段] FAIL：未找到 bytes_erased" -ForegroundColor Red
            $script:expectFailures++
        }
        if ($eraseJson -notmatch '"rtt_stopped"') {
            Write-Host "  [erase 字段] WARN：未找到 rtt_stopped（RTT 可能原本未运行）" -ForegroundColor Yellow
        }
        Run "flash blank-check(after erase)" @("flash","blank-check","--uid",$Uid,"--backend-port",$Port)
        # 回归：擦除后立即烧录，内部校验必须通过（0.2.2 修复：verify 前 reset_and_halt）
        $progJson = & $cliExe @cliPrefix flash program $abs --uid $Uid --backend-port $Port --json 2>$null | Out-String
        Write-Host ""
        Write-Host "===== flash program(after erase,json) =====" -ForegroundColor Cyan
        Write-Host $progJson
        if ($progJson -match '"success":\s*true') {
            Write-Host "  [erase→program] OK：擦除后烧录内部校验通过" -ForegroundColor Green
        } else {
            Write-Host "  [erase→program] FAIL：擦除后烧录失败（见上方 JSON）" -ForegroundColor Red
            $script:expectFailures++
        }
        Run "flash verify(after restore)" @("flash","verify",$abs,"--uid",$Uid,"--backend-port",$Port)
        # fill 的 --value 十六进制解析（RAM，非破坏性；Flash fill 由实机手工用例覆盖）
        Run "flash fill(RAM,value 0x55)" @("flash","fill","--addr","0x20001000","--size","256","--value","0x55","--uid",$Uid,"--backend-port",$Port)
        Run "flash reset" @("flash","reset","--uid",$Uid,"--backend-port",$Port)
        Write-Host "`n已恢复固件。破坏性回环完成。" -ForegroundColor Green
    }
}

# ── I. 调试控制（需已连接探针 + 提供 -Elf）────────────
if ($Elf) {
    if (-not (Test-Path $Elf)) { Write-Host "ELF 不存在: $Elf" -ForegroundColor Red }
    elseif ($Uid) {
        $abs = (Resolve-Path $Elf).Path
        Write-Host "`n## I. 调试控制（ELF=$abs）" -ForegroundColor Green
        Run "debug status" @("debug","status","--uid",$Uid,"--backend-port",$Port)
        Run "debug halt" @("debug","halt","--uid",$Uid,"--backend-port",$Port)
        Run "debug elf load" @("debug","elf","load",$abs,"--uid",$Uid,"--backend-port",$Port)
        Run "debug elf info" @("debug","elf","info","--uid",$Uid,"--backend-port",$Port)
        Run "debug src files" @("debug","src","files","--uid",$Uid,"--backend-port",$Port)
        Run "debug regs" @("debug","regs","--uid",$Uid,"--backend-port",$Port,"--filter","pc")
        Run "debug mem resolve" @("debug","mem","resolve","0x20000000","--uid",$Uid,"--backend-port",$Port)
        Run "debug mem read" @("debug","mem","read","--addr","0x20000000","--size","64","--uid",$Uid,"--backend-port",$Port)
        Run "debug mem usage" @("debug","mem","usage","--uid",$Uid,"--backend-port",$Port)
        Run "debug functions (filter main)" @("debug","functions","--filter","main","--limit","10","--uid",$Uid,"--backend-port",$Port)
        Run "debug disasm (main,10)" @("debug","disasm","--addr","main","--count","10","--uid",$Uid,"--backend-port",$Port)
        Run "debug stack" @("debug","stack","--uid",$Uid,"--backend-port",$Port)
        Run "debug locals" @("debug","locals","--uid",$Uid,"--backend-port",$Port)
        Run "debug callgraph (main)" @("debug","callgraph","--addr","main","--uid",$Uid,"--backend-port",$Port)
        Run "debug hover (main)" @("debug","hover","main","--uid",$Uid,"--backend-port",$Port)
        Run "debug watch eval (main)" @("debug","watch","eval","main","--uid",$Uid,"--backend-port",$Port)
        Run "debug periph list" @("debug","periph","list","--uid",$Uid,"--backend-port",$Port)
        Run "debug periph regs (GPIOA)" @("debug","periph","regs","GPIOA","--uid",$Uid,"--backend-port",$Port)
        Run "debug periph nvic" @("debug","periph","nvic","--uid",$Uid,"--backend-port",$Port)
        Run "debug periph scb" @("debug","periph","scb","--uid",$Uid,"--backend-port",$Port)
        Run "debug periph systick" @("debug","periph","systick","--uid",$Uid,"--backend-port",$Port)
        Run "debug session list" @("debug","session","list","--backend-port",$Port)
        Run "debug session save" @("debug","session","save","smoke",'--data','{"a":1}',"--backend-port",$Port)
        Run "debug session load" @("debug","session","load","smoke","--backend-port",$Port)
        Run "debug session del" @("debug","session","del","smoke","--backend-port",$Port)
        # 断点段：用 src line --addr main 反查出真实 file:line（--line 1 多为注释行，无地址）
        $lineOut = & $cliExe @cliPrefix debug src line --addr main --uid $Uid --backend-port $Port --json 2>$null | Out-String
        $loc = $null
        try { $loc = ($lineOut | ConvertFrom-Json).line } catch { $loc = $null }
        if ($loc -and $loc.file -and $loc.line) {
            $bpLine = "$($loc.line)"
            Run "debug bp add (main:$bpLine)" @("debug","bp","add","--file",$loc.file,"--line",$bpLine,"--uid",$Uid,"--backend-port",$Port)
            Run "debug bp list" @("debug","bp","list","--uid",$Uid,"--backend-port",$Port)
            Run "debug bp del --file+line" @("debug","bp","del","--file",$loc.file,"--line",$bpLine,"--uid",$Uid,"--backend-port",$Port)
            Run "debug bp clear" @("debug","bp","clear","--uid",$Uid,"--backend-port",$Port)
        } else {
            Write-Host "ELF 中未解析到 main 的源码行，跳过断点段" -ForegroundColor DarkGray
        }
        Run "debug run" @("debug","run","--uid",$Uid,"--backend-port",$Port)
    } else {
        Write-Host "无探针，跳过调试段" -ForegroundColor DarkGray
    }
}

# ── 清理 ───────────────────────────────────────────────
if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Write-Host "`n== 测试结束 ==" -ForegroundColor Green
if ($script:encodingFailures -or $script:expectFailures) {
    Write-Host ("失败: 编码检查 " + $script:encodingFailures + " 项，预期失败用例 " + $script:expectFailures + " 项") -ForegroundColor Red
    exit 1
}
exit 0