# ═══════════════════════════════════════════════════════════
# AgEnD 一鍵安裝腳本（多 AI 後端可選）(Windows PowerShell 5)
# 需以「系統管理員身分」執行
# v3.0 - 全 root 安裝 + 官方 install.sh + systemd 服務
# ═══════════════════════════════════════════════════════════

param(
    [switch]$Force,  # 強制重新執行所有階段
    [string]$InstallVersion = $env:AGEND_VERSION,
    [string]$WslDrive = $env:AGEND_WSL_DRIVE,
    [string]$InstallRunId = '',  # 一行安裝指令給的這一次的代號：它讀 last.json 時，只認這一次寫的（#2650）
    [string]$InitiatingSid = ''  # 一行安裝指令（還沒提升權限時）的 Windows 帳號 SID（#2650 第 5 項）
)

$ErrorActionPreference = "Stop"
$ProgressFile = "$env:USERPROFILE\.agend-install-progress"

# ── 固定版本（避免環境不一致）──────────────────────────────
$UBUNTU_DISTRO = "Ubuntu-26.04"
$AGEND_USER = "root"  # AgEnD 安裝在這個 Linux 使用者底下（記到 install.json，捷徑用它，不寫死）
$NODE_VERSION = "22"  # LTS 穩定版，AgEnD 需要 22+

# ── 輔助函式 ─────────────────────────────────────────────

# Stream only installer-owned downloads; both response wait and byte progress are bounded.
function New-InstallDownloadRequest([string]$Uri) { return [Net.WebRequest]::CreateHttp($Uri) }
function Invoke-InstallDownload([string]$Uri, [string]$OutFile, [int]$TimeoutSec = 120, [double]$NoProgressSeconds = 60) {
    $request = New-InstallDownloadRequest $Uri
    $response = $null; $inputStream = $null; $outputStream = $null; $complete = $false
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $wait = {
        $operation = $args[0]
        $left = [Math]::Min($NoProgressSeconds, $TimeoutSec - $clock.Elapsed.TotalSeconds)
        if ($left -le 0 -or -not $operation.Wait([int][Math]::Max(1, $left * 1000))) { throw 'Download exceeded its operation or no-progress deadline; rerun after checking the network.' }
        return $operation.GetAwaiter().GetResult()
    }
    try {
        $response = & $wait ($request.GetResponseAsync())
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] 65536
        while ($true) {
            $count = & $wait ($inputStream.ReadAsync($buffer, 0, $buffer.Length))
            if ($count -eq 0) { break }
            $outputStream.Write($buffer, 0, $count)
        }
        $complete = $true
    } finally {
        $request.Abort()
        if ($outputStream) { $outputStream.Dispose() }; if ($inputStream) { $inputStream.Dispose() }; if ($response) { $response.Dispose() }
        if (-not $complete) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
    }
}

function Write-Step($num, $total, $msg) {
    Write-Host "`n[$num/$total] $msg" -ForegroundColor Cyan
    Write-InstallLog "[$num/$total] $msg"
    Set-InstallStage ([string]$num)
}
function Write-Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green; Write-InstallLog "  [OK] $msg" }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow; Write-InstallLog "  [!!] $msg" }
function Write-Err($msg) {
    Write-Host "  [X] $msg" -ForegroundColor Red; Write-InstallLog "  [X] $msg"
    # 第一次出錯時說一次安裝紀錄在哪裡：視窗關掉以後，回報問題就附上這個檔案。
    if ($script:InstallLog -and -not $script:InstallLogShown) {
        $script:InstallLogShown = $true
        Write-Host "  安裝紀錄（回報問題時請附上這個檔案）：$($script:InstallLog)" -ForegroundColor Yellow
    }
}
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor White; Write-InstallLog "  $msg" }

# ── 安裝紀錄與結果檔（#2650 第 9 項）──────────────────────────
# 視窗關掉以後還要能回報問題：畫面上說的話、長步驟裡子程式的每一行輸出，都寫進 %LOCALAPPDATA%\AgEnD\install-logs 裡
# 這一次的紀錄檔，寫之前先遮掉設定碼、登入碼、token 和網址裡的驗證參數（Protect-LogText）。設定碼與儀表板登入碼的大框
# 直接用 Write-Host 印，本來就不進紀錄。每個紀錄檔最多 5 MB，只留最近 10 個。
# 結果檔 last.json 記這一次的紀錄檔、目前階段（Write-Step 更新）、結果（running／failed／done）和失敗種類
# （Set-InstallFailure）；一行安裝指令（install.ps1）在安裝程式結束、失敗或視窗被關掉時讀它，說出停在哪一步和紀錄檔的位置。
# 寫紀錄失敗絕不影響安裝。
$INSTALL_LOG_MAX_BYTES = 5MB
$INSTALL_LOG_KEEP = 10
$script:InstallLog = $null; $script:InstallLogShown = $false; $script:InstallLogFull = $false
$script:InstallStage = 'start'; $script:InstallFailure = $null; $script:InstallRunId = ''
function Get-InstallLogDir {
    if (-not $env:LOCALAPPDATA) { return $null }
    return (Join-Path (Join-Path $env:LOCALAPPDATA 'AgEnD') 'install-logs')
}
function Protect-LogText([string]$text) {
    $t = $text
    $t = $t -replace '(?i)([?&#](?:code|token|state|key|sig|signature|secret|password|access_token|id_token|refresh_token|auth)=)[^&#\s]+', '$1[hidden]'
    $t = $t -replace '\b\d{6,}:[A-Za-z0-9_-]{30,}', '[hidden token]'
    $t = $t -replace '[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}', '[hidden token]'
    $t = $t -replace '\b(?:sk-|gh[pousr]_|xox[abpr]-|AKIA)[A-Za-z0-9_-]{12,}', '[hidden token]'
    $t = $t -replace '(?i)\b(authorization)(\s*[:=]\s*).+$', '$1$2[hidden]'
    $t = $t -replace '(?i)\b(token|password|passwd|secret|api[ _-]?key)(\s*[:=]\s*)(?!\[hidden)\S+', '$1$2[hidden]'
    $t = $t -replace '(?i)\b(bearer)(\s+)(?!\[hidden)\S+', '$1$2[hidden]'
    # code: 後面的值：錯誤碼（數字、0x…）留著，診斷要用；其他（登入碼、設定碼）遮掉。
    $t = $t -replace '(?i)\b(code)(\s*[:=]\s*)(?!\[hidden|0x[0-9a-f]+\b|-?\d+\b)\S+', '$1$2[hidden]'
    $t = $t -replace '\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b', '[hidden code]'
    return $t
}
function Write-InstallLog([string]$text) {
    if (-not $script:InstallLog -or $script:InstallLogFull) { return }
    try {
        $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + (Protect-LogText $text) + "`r`n"
        $size = 0; try { $size = (Get-Item -LiteralPath $script:InstallLog -ErrorAction Stop).Length } catch { }
        if ($size + $line.Length * 3 -gt $INSTALL_LOG_MAX_BYTES) {
            $script:InstallLogFull = $true
            $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " [log reached $INSTALL_LOG_MAX_BYTES bytes; later lines are not kept]`r`n"
        }
        [IO.File]::AppendAllText($script:InstallLog, $line, (New-Object System.Text.UTF8Encoding $true))
    } catch { }
}
function Save-InstallReceipt([string]$outcome, [string[]]$pendingSignIns = @()) {
    $dir = Get-InstallLogDir
    if (-not $dir) { return }
    if ($outcome -eq 'done') { $script:InstallFailure = $null }
    try {
        $receipt = [ordered]@{
            run = $script:InstallRunId; outcome = $outcome; stage = $script:InstallStage; failure = $script:InstallFailure
            log = $script:InstallLog; pendingSignIns = @($pendingSignIns); time = (Get-Date).ToUniversalTime().ToString('o')
        } | ConvertTo-Json -Compress
        $file = Join-Path $dir 'last.json'
        [IO.File]::WriteAllText("$file.tmp", $receipt, (New-Object System.Text.UTF8Encoding $false))
        Move-Item -LiteralPath "$file.tmp" -Destination $file -Force
    } catch { }
}
# 進到新的一步：上一步重試成功前記下的失敗種類不再算數。
function Set-InstallStage([string]$stage) { $script:InstallStage = $stage; $script:InstallFailure = $null; Save-InstallReceipt 'running' }
# 失敗的種類：network、download、wsl、backend、agend、auth、service、setup、error（沒預料到的錯誤）。
function Set-InstallFailure([string]$kind) {
    $script:InstallFailure = $kind
    Write-InstallLog "FAILED stage=$($script:InstallStage) kind=$kind"
    Save-InstallReceipt 'failed'
}
function Start-InstallLog([string]$runId) {
    if ($runId -match '^[0-9a-f]{32}$') { $script:InstallRunId = $runId }
    $dir = Get-InstallLogDir
    if (-not $dir) { return }
    try {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        @(Get-ChildItem -LiteralPath $dir -Filter 'install-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
            Select-Object -Skip ($INSTALL_LOG_KEEP - 1)) | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
        $script:InstallLog = Join-Path $dir ('install-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + $PID + '.log')
        $os = try { [Environment]::OSVersion.VersionString } catch { '?' }
        Write-InstallLog ("AgEnD installer started; PowerShell {0}; {1}; {2}; requested version '{3}'; Force={4}" -f $PSVersionTable.PSVersion, $os, $env:PROCESSOR_ARCHITECTURE, $InstallVersion, [bool]$Force)
        Save-InstallReceipt 'running'
    } catch { $script:InstallLog = $null }
}

function Stage-Done($stage) {
    if ($Force) { return $false }
    if (Test-Path $ProgressFile) {
        return [bool]((Get-Content $ProgressFile -Raw) -match "STAGE_${stage}_DONE")
    }
    return $false
}
function Mark-Stage($stage) { Add-Content -Path $ProgressFile -Value "STAGE_${stage}_DONE" }
# 進度檔裡某個鍵最後一次存的值（沒有就 $null）。用最後一筆：同一個鍵可能存過不只一次（#2238 審查）。
function Get-ProgressValue([string]$key, [string]$pattern = '\S+') {
    if (-not (Test-Path $ProgressFile)) { return $null }
    $content = Get-Content $ProgressFile -Raw
    if ($null -eq $content) { return $null }
    $all = [regex]::Matches($content, "(?m)^$key=($pattern)\s*$")
    if ($all.Count -eq 0) { return $null }
    return $all[$all.Count - 1].Groups[1].Value
}
# -Force 是全部重來：舊的進度（含上次選的 Linux 與後端）一開始就清掉，之後中斷再接續，讀到的才是這一次的選擇。
function Start-FreshProgress([bool]$force) {
    if ($force -and (Test-Path $ProgressFile)) { Remove-Item -LiteralPath $ProgressFile -Force -ErrorAction SilentlyContinue }
}

function Resolve-AgendInstallVersion([string]$value) {
    if ($value -eq '') { return '' }
    if ($value.Length -gt 128 -or -not [regex]::IsMatch($value, '\A(?:beta|latest|(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)\z')) {
        throw 'AGEND_VERSION must be beta, latest, or an exact semantic version (for example 2.3.2-beta.5).'
    }
    return $value
}

# Explicit input wins; a manual resume without the environment uses the saved choice. -Force ignores old progress.
function Get-SavedInstallVersion([string]$requested, [bool]$force) {
    if ($requested -ne '') { return (Resolve-AgendInstallVersion $requested) }
    if ($force) { return '' }
    return (Resolve-AgendInstallVersion ([string](Get-ProgressValue 'AGEND_VERSION' '[^\r\n]*')))
}
function Save-InstallVersion([string]$version) {
    $version = Resolve-AgendInstallVersion $version
    if ($version) { Add-Content -Path $ProgressFile -Value ("AGEND_VERSION=" + $version) }
}
# 安裝檔從哪裡下載，依序：GitHub Pages，再來是 GitHub raw 上「已部署的那一份」（tag installer-live 只在 Pages 部署成功後
# 才移到那個 commit，見 deploy-website.yml）。有些公司網路擋掉所有 *.github.io，但 raw.githubusercontent.com 可以連。
function Get-InstallSources { return @('https://songsid.github.io/AgEnD', 'https://raw.githubusercontent.com/songsid/AgEnD/installer-live/website/public') }
# 在 WSL 裡下載 install.sh 再執行：依序試每個來源，下載完整、而且開頭兩行正好是 install.sh 的開頭才執行（不會把半份、
# 或擋下來、內容帶著網址的網頁交給 bash）。在子 shell 裡：它的 exit 和清理只屬於這一段，外面的 set -e 照樣看結束碼。腳本裡沒有雙引號。
function Get-AgendInstallShScript([string]$pin, [string[]]$sources = (Get-InstallSources)) {
    $urls = ($sources | ForEach-Object { $_.TrimEnd('/') + '/install.sh' }) -join ' '
    return ('( f=$(mktemp) || exit 1; trap ''rm -f -- $f'' EXIT; ok=; for u in ' + $urls + '; do ' +
        'if curl --connect-timeout 20 --max-time 120 -fsSL -o $f $u && head -n 1 $f | grep -qx ''#!/usr/bin/env bash'' && sed -n 2p $f | grep -qx ''# AgEnD Bootstrap Installer''; then ok=1; break; fi; ' +
        'echo AgEnD: could not fetch $u, trying the next source >&2; done; ' +
        '[ x$ok = x1 ] || { echo AgEnD: install.sh could not be fetched from songsid.github.io or raw.githubusercontent.com >&2; exit 1; }; ' +
        $pin + 'bash < $f )')
}
function Get-AgendInstallCommand([string]$version) {
    $version = Resolve-AgendInstallVersion $version
    $pin = ''; if ($version) { $pin = "AGEND_VERSION=$version " }
    return (Get-AgendInstallShScript $pin)
}
# 重新開機後的接續：Windows 的 RunOnce 只執行一行短指令（官方建議 260 字以內），放不下兩個來源，所以把「依序試兩個
# 來源、下載 install.ps1 再執行」寫成這個帳號底下的一個小腳本，RunOnce 只執行它。內容只有 ASCII（5.1 讀沒有 BOM 的
# 檔案用系統字碼頁）。$version 已經驗證過（Resolve-AgendInstallVersion）。
function Get-InstallResumeScript([string]$version, [string[]]$sources = (Get-InstallSources)) {
    $version = Resolve-AgendInstallVersion $version
    $urls = ($sources | ForEach-Object { "'" + $_.TrimEnd('/') + "/install.ps1'" }) -join ', '
    $lines = @(
        '# AgEnD: carry on the Windows install after a restart. Written by install-agend.ps1, run once by RunOnce.'
        "if (`$PSVersionTable.PSEdition -eq 'Desktop') { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 }"
    )
    if ($version) { $lines += ("`$env:AGEND_VERSION = '" + $version + "'") }
    $lines += @(
        '$installer = $null'
        ('foreach ($u in @(' + $urls + ')) {')
        '    try {'
        '        $t = [string](Invoke-RestMethod -Uri $u -UseBasicParsing -TimeoutSec 120)'
        '        if ($t -match ''function Invoke-InstallDownload\('') { $installer = $t; break }'
        '        Write-Host "AgEnD: $u did not return the installer; trying the next source."'
        '    } catch { Write-Host "AgEnD: $u could not be reached ($($_.Exception.Message)); trying the next source." }'
        '}'
        'if ($installer) { Invoke-Expression $installer } else {'
        '    Write-Host ''AgEnD: the installer could not be downloaded from songsid.github.io or raw.githubusercontent.com.'' -ForegroundColor Red'
        '    Write-Host ''Check the network, then run the install command from the install page again: it carries on where it stopped.'''
        '    Read-Host ''Press Enter to close'' | Out-Null'
        '}'
    )
    return (($lines -join "`r`n") + "`r`n")
}
function Get-InstallResumeScriptPath { return (Join-Path $env:LOCALAPPDATA 'AgEnD\install-resume.ps1') }
function Get-InstallResumeCommand([string]$path) {
    return ('powershell -NoProfile -ExecutionPolicy ByPass -File "' + $path + '"')
}

# ── 重新開機後自動接續、自動選擇（#1853：使用者核准的第 ② 步）──────────────
# 需要重新開機時，登記一個「登入後執行一次」（HKCU RunOnce）：登入後自動再跑同一行安裝指令，從中斷處繼續。
# 每次安裝程式一開始就先清掉它，只在要重新開機前才登記，所以完成或失敗都不會留下舊的登記。Windows 執行它之前也會先刪掉它。
# 接續一律跑 install.ps1（它會請你同意一次系統管理員權限），不帶 -Force：接續只是繼續，不是重來。它先試 GitHub Pages，
# 連不上再用 raw 上已部署的那一份（Get-InstallResumeScript），所以擋掉 *.github.io 的網路也能接續。
$RESUME_KEY = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$RESUME_NAME = 'AgEnDInstallResume'
function Register-ResumeAtLogon {
    try {
        $path = Get-InstallResumeScriptPath
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
        [IO.File]::WriteAllText($path, (Get-InstallResumeScript $AgendInstallVersion), (New-Object Text.UTF8Encoding $false))
        if (-not (Test-Path $RESUME_KEY)) { New-Item -Path $RESUME_KEY -Force | Out-Null }
        Set-ItemProperty -Path $RESUME_KEY -Name $RESUME_NAME -Value (Get-InstallResumeCommand $path)
        return $true
    } catch { return $false }
}
function Clear-ResumeAtLogon {
    try { Remove-ItemProperty -Path $RESUME_KEY -Name $RESUME_NAME -ErrorAction Stop } catch { }
    try { Remove-Item -LiteralPath (Get-InstallResumeScriptPath) -Force -ErrorAction Stop } catch { }
}
# 要重新開機時：登記接續，說明會發生什麼，問一次要不要現在重開。接續的登記和進度都在這個 Windows 帳號底下，
# 所以要說清楚重新開機後要用哪個帳號登入（#2650 第 5 項）。
function Request-Reboot([string]$why) {
    Write-Warn $why
    $registered = Register-ResumeAtLogon
    $account = Get-InstallAccountName
    if ($registered) {
        Write-Info "重新開機後，請用 Windows 帳號「$account」登入，安裝會自動繼續（會先跳出一個 Windows 確認視窗，請選「是」）。"
    } else {
        Write-Info "重新開機後，請用 Windows 帳號「$account」登入，再執行一次同一行安裝指令，會從中斷處繼續。"
    }
    Write-Info "用別的帳號登入不會接續：進度和自動接續只記在「$account」底下。"
    $reboot = Read-Host "  按 Enter 立刻重新開機；輸入 n 再按 Enter 先不重開"
    if ($reboot -notmatch '^\s*[nN]') { Restart-Computer -Force }
    if ($registered) { Write-Info "好的。之後你自己重新開機，登入後一樣會自動繼續。" }
    exit 0
}

# ── 網路檢查：安裝真正要連的地方，Windows 和 WSL 分開檢查（#2650 第 8 項）──────────
# 以前只連一次 Google，連不上就整個停下來：Google 被擋、但需要的網站都能連的公司網路會被誤擋；反過來，Windows 的瀏覽器
# 走公司 proxy 能連，WSL 裡的 curl/apt/npm 卻不行時，檢查通過了，後面的下載才失敗或一直等。現在：
# - Windows 這邊：連 songsid.github.io（安裝指令與重新開機後的接續都從這裡下載；被擋時改用 raw.githubusercontent.com 上
#   同一份已部署的，兩個有一個能連就好）和 GitHub（WSL 更新的備案，
#   連不上只警告）。
# - WSL 這邊（Ubuntu 好了之後、安裝 AgEnD 之前）：AgEnD 的安裝程式、npm、Node.js、nvm 必須能連；Ubuntu 套件庫和各家
#   AI 後端的網站連不上只警告。
# 每個網址最多試 2 次、每次 10 秒（WSL 裡的同時檢查）；回應任何 HTTP 狀態碼都算連得上。連不上時分清楚原因（DNS、逾時、連線被拒、
# HTTPS 憑證、proxy），說明 proxy 和公司憑證要怎麼設定；必須的連不上時先問要不要繼續，預設不繼續。proxy 的帳密不寫進
# 畫面或安裝紀錄。
$NET_WINDOWS = @(
    @{ Host = 'songsid.github.io'; Why = 'AgEnD 安裝程式'; Required = $true }
    @{ Host = 'github.com'; Why = 'WSL 更新（備案）'; Required = $false }
    @{ Host = 'raw.githubusercontent.com'; Why = 'Ubuntu 映像檔清單'; Required = $false }
)
$NET_WSL = @(
    @{ Host = 'songsid.github.io'; Why = 'AgEnD 安裝程式'; Required = $true }
    @{ Host = 'registry.npmjs.org'; Why = 'npm 套件'; Required = $true }
    @{ Host = 'nodejs.org'; Why = 'Node.js'; Required = $true }
    @{ Host = 'raw.githubusercontent.com'; Why = 'nvm'; Required = $true }
    @{ Host = 'archive.ubuntu.com'; Why = 'Ubuntu 套件庫'; Required = $false }
    @{ Host = 'cli.kiro.dev'; Why = 'Kiro CLI'; Required = $false }
    @{ Host = 'claude.ai'; Why = 'Claude Code'; Required = $false }
    @{ Host = 'chatgpt.com'; Why = 'Codex'; Required = $false }
    @{ Host = 'antigravity.google'; Why = 'Antigravity'; Required = $false }
)
# 一個連線錯誤的原因：'dns'、'timeout'、'refused'、'tls'、'proxy' 或 'other'。$err 是例外（或它的訊息）。
function Get-NetFailureKind($err) {
    $status = ''
    $text = ''
    try { $e = $err.Exception; while ($e) { if ($e -is [Net.WebException]) { $status = [string]$e.Status }; $text += ' ' + $e.Message; $e = $e.InnerException } } catch { }
    if (-not $text) { $text = [string]$err }
    if ($status -eq 'ProxyNameResolutionFailure' -or $text -match '\(407\)|Proxy Authentication|proxy') { return 'proxy' }
    if ($status -eq 'NameResolutionFailure' -or $text -match 'could not be resolved|No such host|Name or service not known|nodename nor servname|無法解析') { return 'dns' }
    if ($status -in 'TrustFailure', 'SecureChannelFailure' -or $text -match 'SSL|TLS|certificate|trust relationship|憑證') { return 'tls' }
    if ($status -eq 'Timeout' -or $text -match 'timed out|timeout|逾時') { return 'timeout' }
    if ($status -eq 'ConnectFailure' -or $text -match 'actively refused|Connection refused|unable to connect|無法連線') { return 'refused' }
    return 'other'
}
# Windows 這邊連一個網址：$null（連得上：任何 HTTP 回應都算），或原因（Get-NetFailureKind）。
function Test-WindowsEndpoint([string]$hostName, [int]$tries = 2, [int]$timeoutSec = 10) {
    $kind = 'other'
    for ($i = 1; $i -le $tries; $i++) {
        try {
            $null = Invoke-WebRequest -Uri "https://$hostName/" -Method Head -TimeoutSec $timeoutSec -UseBasicParsing -ErrorAction Stop
            return $null
        } catch {
            $resp = $null; try { $resp = $_.Exception.Response } catch { }
            # 407 是 proxy 要登入，不是網站的回應：算 proxy 問題，不算連得上（Prism 審查）。
            $code = 0; if ($resp) { try { $code = [int]$resp.StatusCode } catch { } }
            if ($code -eq 407) { return 'proxy' }
            if ($code -gt 0) { return $null }                                   # 其他 HTTP 回應（403、404、405、3xx 都算）：連得上
            $kind = Get-NetFailureKind $_
        }
    }
    return $kind
}
# Windows 用的 proxy（給 https://$hostName/ 的），沒有就 $null。只回傳主機和連接埠，帳密絕不帶出來。
function Get-WindowsProxy([string]$hostName = 'songsid.github.io') {
    try {
        $uri = [Uri]"https://$hostName/"
        $p = [Net.WebRequest]::GetSystemWebProxy().GetProxy($uri)
        if ($p -and $p.Host -and $p.Host -ne $uri.Host) { return ('{0}:{1}' -f $p.Host, $p.Port) }
    } catch { }
    return $null
}
function Format-NetFailure([string]$kind) {
    switch ($kind) {
        'dns' { return '找不到這個網址（DNS）' }
        'timeout' { return '逾時' }
        'refused' { return '連線被拒或被防火牆擋住' }
        'tls' { return 'HTTPS 憑證不被信任（常見於公司會檢查加密連線的網路）' }
        'handshake' { return 'HTTPS 連線在握手時被切斷（常見於防火牆擋掉這個網站，不是憑證的問題）' }
        'proxy' { return 'proxy 擋住或需要登入' }
        'curl' { return 'WSL 裡沒有 curl，無法檢查' }
    }
    return '連不上'
}
# 依原因說明怎麼做。$where：'windows' 或 'wsl'；$proxy：Windows 用的 proxy（或 $null）。
function Write-NetAdvice([string[]]$kinds, [string]$where, $proxy) {
    if ($kinds -contains 'handshake') {
        Write-Info "  連線在 HTTPS 握手時就被切斷：多半是防火牆擋掉了那個網站，不是憑證的問題。"
        Write-Info "  songsid.github.io 被擋時，安裝程式會改用 raw.githubusercontent.com 上同一份已部署的安裝程式。"
    }
    if ($kinds -contains 'tls') {
        Write-Info "  HTTPS 憑證的問題：公司網路常用自己的憑證檢查加密連線。請向 IT 人員要公司的根憑證（.crt），"
        if ($where -eq 'wsl') {
            Write-Info "  放到 Ubuntu 的 /usr/local/share/ca-certificates/ 再執行 update-ca-certificates；Node.js 另外設定 NODE_EXTRA_CA_CERTS 指向這個檔案。"
        } else {
            Write-Info "  或確認 Windows 已安裝它（IT 通常會統一安裝）。請不要關掉憑證檢查。"
        }
    }
    if ($proxy) {
        Write-Info "  Windows 透過 proxy（$proxy）上網。"
        if ($where -eq 'wsl') {
            Write-Info "  WSL 不一定會跟著用：可以在 Ubuntu 的 /etc/environment 加上 http_proxy=http://$proxy 和 https_proxy=http://$proxy，"
            Write-Info "  或請 IT 人員協助（需要帳密的 proxy，請不要把密碼寫進共用的檔案）。"
        }
    } elseif ($kinds -contains 'proxy') {
        Write-Info "  看起來有 proxy 擋住，或要先登入：請確認 proxy 設定，或請 IT 人員協助。"
    }
    if ($kinds -contains 'dns' -or $kinds -contains 'timeout' -or $kinds -contains 'refused') {
        if ($where -eq 'wsl') {
            Write-Info "  Windows 連得上、WSL 連不上時，常見原因是 VPN 或 WSL 的 DNS 設定：可以先中斷 VPN 再試，或請 IT 人員協助。"
        } else {
            Write-Info "  請確認網路正常（飯店或公司的登入頁要先登入）、防火牆沒有擋住這些網址，或換一個網路（例如手機熱點）再試。"
        }
    }
}
# 必須的網站有備用來源時（*.github.io 被擋的公司網路：GitHub raw 上同一份已部署的安裝程式），備用的連得上就算通過，
# 兩個都說出來；兩個都連不上才算失敗。
$NET_ALTERNATES = @{ 'songsid.github.io' = 'raw.githubusercontent.com' }
# 印出檢查結果並決定要不要繼續：必須的都連得上（或它的備用來源連得上，或使用者明確回答 y）回傳 $true。$results：@{ Host; Why; Required; Kind }。
function Resolve-NetResults($results, [string]$where) {
    $failed = @($results | Where-Object { $_.Kind })
    $label = if ($where -eq 'wsl') { 'WSL 裡' } else { 'Windows' }
    if ($failed.Count -eq 0) { Write-Ok "$label 的網路連線正常（需要的網站都連得上）"; return $true }
    $byHost = @{}; foreach ($r in $results) { $byHost[$r.Host] = $r }
    # 連線方式和 curl 的結束碼：回報問題時，從安裝紀錄就分得出是防火牆擋網站，還是 proxy 在檢查加密連線。
    $via = @($results | Where-Object { $_.Via } | ForEach-Object { $_.Via }) | Select-Object -First 1
    if ($via) { Write-Info $(if ($via -eq 'direct') { "$label 直接連線（沒有設定 https_proxy）" } else { "$label 經過 proxy $via 連線" }) }
    foreach ($r in $failed) { if ($null -ne $r.Code) { Write-InstallLog ("  {0} {1}：curl 結束碼 {2}（{3}）" -f $label, $r.Host, $r.Code, $r.Kind) } }
    $required = @()
    foreach ($r in $failed) {
        $line = "{0} 連不上 {1}（{2}）：{3}" -f $label, $r.Host, $r.Why, (Format-NetFailure $r.Kind)
        $alt = if ($NET_ALTERNATES.ContainsKey($r.Host)) { $NET_ALTERNATES[$r.Host] } else { $null }
        $altOk = $alt -and $byHost.ContainsKey($alt) -and -not $byHost[$alt].Kind
        if (-not $r.Required) { Write-Warn ($line + "；只有用到時才需要") }
        elseif ($altOk) { Write-Warn ($line + "；改用 $alt（同一份已部署的安裝程式），可以繼續") }
        else {
            if ($alt) { $line += "；備用來源 $alt 也連不上" }
            Write-Err $line; $required += $r
        }
    }
    Write-NetAdvice @($failed | ForEach-Object { $_.Kind }) $where (Get-WindowsProxy $failed[0].Host)
    if ($required.Count -eq 0) { return $true }
    $answer = Read-Host "  安裝需要上面這些網站，現在多半會失敗。還是要繼續嗎？(y/N)"
    return (([string]$answer) -match '^\s*[yY]\s*$')
}
function Test-WindowsNetwork {
    Write-Info "檢查網路連線（安裝需要的網站）..."
    $jobs = @($NET_WINDOWS | ForEach-Object { @{ Host = $_.Host; Why = $_.Why; Required = $_.Required; Kind = (Test-WindowsEndpoint $_.Host) } })
    return (Resolve-NetResults $jobs 'windows')
}
# WSL 裡同時檢查（curl，每個最多 2 次、每次 10 秒），一行一個結果：NET|主機|curl 結束碼。腳本裡沒有雙引號（5.1 傳參數的問題）。
function Get-WslNetScript($endpoints) {
    $hosts = ($endpoints | ForEach-Object { $_.Host }) -join ' '
    return @(
        'command -v curl >/dev/null 2>&1 || { echo NET_NO_CURL; exit 0; }'
        ('for h in ' + $hosts + '; do ( c=1; for i in 1 2; do curl -sS -o /dev/null -m 10 https://$h/ 2>/dev/null; c=$?; [ $c -eq 0 ] || [ $c -eq 22 ] && break; done; echo NET\|$h\|$c ) & done; wait')
        # 這些連線怎麼出去：直接，或經過 https_proxy（只印主機和連接埠，帳密不印）。分辨「防火牆擋網站」和「proxy 檢查加密連線」。
        'p=${https_proxy:-${HTTPS_PROXY:-}}; p=${p#*://}; p=${p##*@}; p=${p%%/*}; echo NET_PATH\|${p:-direct}'
    ) -join "`n"
}
# curl 的結束碼 → 原因（0、22 是有 HTTP 回應）。35 是握手失敗（連線在 TLS 握手時被切斷：防火牆擋網站），和 60 這類
# 「憑證不被信任」（公司檢查加密連線）分開：兩種的處理方式不同。
function Get-CurlFailureKind([int]$code) {
    switch ($code) {
        { $_ -in 0, 22 } { return $null }
        { $_ -in 5, 97 } { return 'proxy' }
        6 { return 'dns' }
        7 { return 'refused' }
        28 { return 'timeout' }
        35 { return 'handshake' }
        { $_ -in 51, 53, 54, 58, 59, 60, 66, 77, 80, 83, 90, 91 } { return 'tls' }
    }
    return 'other'
}
function ConvertFrom-WslNetOutput([string]$text, $endpoints) {
    if ($text -match 'NET_NO_CURL') { return @($endpoints | ForEach-Object { @{ Host = $_.Host; Why = $_.Why; Required = $false; Kind = 'curl' } }) }
    $codes = @{}
    foreach ($m in [regex]::Matches($text, '(?m)^NET\|([A-Za-z0-9.-]+)\|(\d+)\s*$')) { $codes[$m.Groups[1].Value] = [int]$m.Groups[2].Value }
    $path = [regex]::Match($text, '(?m)^NET_PATH\|([A-Za-z0-9._:\[\]-]{1,200})\s*$')
    $via = if ($path.Success) { $path.Groups[1].Value } else { $null }
    return @($endpoints | ForEach-Object {
        $c = if ($codes.ContainsKey($_.Host)) { $codes[$_.Host] } else { $null }
        $k = if ($null -ne $c) { Get-CurlFailureKind $c } else { 'other' }
        @{ Host = $_.Host; Why = $_.Why; Required = $_.Required; Kind = $k; Code = $c; Via = $via }
    })
}
function Test-WslNetwork([string]$distro) {
    Write-Info "檢查 WSL 裡的網路連線（安裝需要的網站）..."
    $text = ''
    $file, $wslFile = New-WslScriptFile (Get-WslNetScript $NET_WSL)
    $prevEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $probe = Invoke-BoundedWsl -Arguments @('-d', $distro, '-u', 'root', '--exec', 'bash', $wslFile) -TimeoutSeconds 60
        if ($probe.Code -eq 0) { $text = $probe.Text }
    } catch { $text = '' } finally {
        $ErrorActionPreference = $prevEAP
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    return (Resolve-NetResults (ConvertFrom-WslNetOutput $text $NET_WSL) 'wsl')
}

# ── 安裝給哪個 Windows 帳號（#2650 第 5 項）──────────────────
# WSL 的 Linux、桌面捷徑、安裝進度、重新開機後的自動接續、瀏覽器，都屬於「執行這個安裝程式的帳號」。一般帳號在
# 系統管理員確認視窗裡輸入另一個系統管理員的帳密時，這個安裝程式就會以那個帳號執行，東西全部裝到那個帳號底下，
# 原本的使用者什麼都看不到。一行安裝指令把提升權限之前的帳號 SID 傳進來（-InitiatingSid）；和現在的帳號不同就
# 停下來，說清楚兩個帳號，不安裝任何東西。直接以系統管理員執行這個腳本（沒有 -InitiatingSid）時沒有可比對的，照常安裝。
function Get-CurrentSid { try { return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { return $null } }
function Get-AccountName([string]$sid) {
    try { return (New-Object Security.Principal.SecurityIdentifier $sid).Translate([Security.Principal.NTAccount]).Value } catch { return $sid }
}
function Get-InstallAccountName {
    try { return [Security.Principal.WindowsIdentity]::GetCurrent().Name } catch { }
    if ($env:USERNAME) { return $env:USERNAME }
    return '?'
}
# 回傳 $null（同一個帳號，或沒有可比對的），或 @{ Started; Running }：兩個帳號的名稱。
function Get-InstallIdentityMismatch([string]$initiatingSid, [string]$currentSid) {
    if ($initiatingSid -notmatch '^S-1-\d+(-\d+)+$' -or -not $currentSid) { return $null }
    if ($initiatingSid -eq $currentSid) { return $null }
    return @{ Started = (Get-AccountName $initiatingSid); Running = (Get-AccountName $currentSid) }
}
function Write-InstallIdentityMismatch($mismatch) {
    Write-Err ("安裝是從 Windows 帳號「{0}」開始的，但系統管理員確認視窗用的是另一個帳號「{1}」。" -f $mismatch.Started, $mismatch.Running)
    Write-Info ("這樣繼續的話，WSL、AgEnD、桌面捷徑和重新開機後的接續都會裝到「{0}」底下，「{1}」看不到也用不到。所以先停在這裡，沒有安裝或修改任何東西。" -f $mismatch.Running, $mismatch.Started)
    Write-Info "可以這樣做："
    Write-Info ("  - 要給「{0}」用：請公司的 IT 人員暫時讓這個帳號有系統管理員權限，再用它執行同一行安裝指令。" -f $mismatch.Started)
    Write-Info ("  - 要給「{0}」用：登出，用「{0}」登入 Windows，再執行同一行安裝指令。" -f $mismatch.Running)
}

# 安裝位置：系統碟有 20 GB 以上就用它（通常是 SSD），否則用可用空間最大、至少 5 GB 的本機磁碟。$disks 的每一項有 Root 和 Free。
function Select-InstallDrive($disks, [string]$systemDrive) {
    $sys = @($disks | Where-Object { $_.Root -ieq $systemDrive }) | Select-Object -First 1
    if ($sys -and $sys.Free -ge 20GB) { return $sys }
    return (@($disks | Where-Object { $_.Free -ge 5GB } | Sort-Object -Property Free -Descending) | Select-Object -First 1)
}
# Only a local drive letter crosses the elevated launch boundary; never interpolate an arbitrary path.
function Resolve-AgendWslDrive([string]$value) {
    if (-not $value) { return '' }
    if ($value -notmatch '\A([A-Za-z])(?::[\\/]?)?\z') { throw 'AGEND_WSL_DRIVE must be a local drive letter, for example D:.' }
    return ($Matches[1].ToUpperInvariant() + ':\')
}
function Get-SavedWslDrive([string]$requested, [bool]$force) {
    if ($requested) { return (Resolve-AgendWslDrive $requested) }
    if ($force) { return '' }
    return (Resolve-AgendWslDrive ([string](Get-ProgressValue 'AGEND_WSL_DRIVE' '[^\r\n]+')))
}
function Save-WslDrive([string]$drive) {
    if ($drive) { Add-Content -LiteralPath $ProgressFile -Value ('AGEND_WSL_DRIVE=' + (Resolve-AgendWslDrive $drive)) }
}
# A recorded installed distro that has been removed is different from a not-yet-created planned install.
function Clear-MissingWslTarget($names) {
    if ($null -eq $names) { return $false }
    $prior = Get-ProgressValue 'DISTRO' '[^\r\n]+'
    if (-not $prior -or $names -contains $prior) { return $false }
    $keep = @([IO.File]::ReadAllLines($ProgressFile) | Where-Object { $_ -notmatch '^(DISTRO=|WSL_INSTALL_(PATH|DISTRO)=|AGEND_WSL_DRIVE=|STAGE_1_DONE$)' })
    [IO.File]::WriteAllLines($ProgressFile, $keep)
    Write-Warn "上次選定的 Linux「$prior」已不存在；這次會重新選擇安裝位置，不會沿用舊位置。"
    return $true
}
function Read-InstallDrive($disks, [string]$systemDrive, [string]$requested = '') {
    $eligible = @($disks | Where-Object { $_.Free -ge 5GB -and $_.Root -match '\A[A-Za-z]:\\\z' } | Sort-Object Root)
    if (-not $eligible.Count) { throw '找不到可用空間 5 GB 以上的本機磁碟。請清出空間後再執行安裝。' }
    $requested = Resolve-AgendWslDrive $requested
    if ($requested) {
        $found = @($eligible | Where-Object { $_.Root -ieq $requested })
        if (-not $found.Count) { throw "AGEND_WSL_DRIVE 指定的 $requested 不是可用空間至少 5 GB 的本機磁碟。請修正後重試。" }
        return $found[0]
    }
    if ($eligible.Count -eq 1) { return $eligible[0] }
    $recommended = Select-InstallDrive $eligible $systemDrive
    $default = 1
    Write-Info '請選擇 WSL 安裝位置（建議選擇 SSD 磁碟）：'
    for ($i = 0; $i -lt $eligible.Count; $i++) {
        $mark = ''; if ($eligible[$i].Root -ieq $recommended.Root) { $default = $i + 1; $mark = '（預設）' }
        Write-Info ("  [{0}] {1} — 可用 {2} GB {3}" -f ($i + 1), $eligible[$i].Root, [math]::Round($eligible[$i].Free / 1GB, 1), $mark)
    }
    while ($true) {
        $answer = "$(Read-Host "  請輸入編號；直接按 Enter 使用 [$default]")".Trim()
        if (-not $answer) { return $eligible[$default - 1] }
        $index = 0
        if ([int]::TryParse($answer, [ref]$index) -and $index -ge 1 -and $index -le $eligible.Count) { return $eligible[$index - 1] }
        Write-Warn "請輸入 1 到 $($eligible.Count) 的編號，或直接按 Enter 使用預設。"
    }
}
function Get-WslInstallLocation($disks, [string]$systemDrive, [string]$distro, [string]$leaf, [string]$requestedDrive = '') {
    $prior = Get-ProgressValue 'WSL_INSTALL_PATH' '[^\r\n]+'
    if ($prior) {
        $owner = Get-ProgressValue 'WSL_INSTALL_DISTRO' '[^\r\n]+'
        $drive = if ($prior -match '\A([A-Za-z]:\\)WSL\\[A-Za-z0-9.-]+\z') { $Matches[1] } else { '' }
        if (-not $drive -or $owner -cne $distro -or $prior -ine ($drive + 'WSL\' + $leaf)) { throw '已儲存的 WSL 安裝位置不符合這次的 Linux；沒有安裝任何東西，請檢查安裝進度。' }
        $disk = Read-InstallDrive $disks $systemDrive $drive
        return @{ Path = $prior; Disk = $disk }
    }
    $disk = Read-InstallDrive $disks $systemDrive $requestedDrive
    $location = $disk.Root + 'WSL\' + $leaf
    # Save before any download/install. Reboots and retries retain the full location, not a new automatic pick.
    Add-Content -LiteralPath $ProgressFile -Value @(('WSL_INSTALL_DISTRO=' + $distro), ('WSL_INSTALL_PATH=' + $location))
    return @{ Path = $location; Disk = $disk }
}

function Get-LocalDisks {
    try {
        return @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop | ForEach-Object { [PSCustomObject]@{ Root = ($_.DeviceID + '\'); Free = [double]$_.FreeSpace } })
    } catch {
        return @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -and -not $_.DisplayRoot } | ForEach-Object { [PSCustomObject]@{ Root = $_.Root; Free = [double]$_.Free } })
    }
}

# 以 root 確認 WSL 能用。不行時先只重新啟動這個 Linux（wsl --terminate，只動到我們自己的發行版）再試，最多兩次；
# 還是不行才問要不要重新啟動整個 WSL，預設不要。wsl --shutdown 會停掉這台電腦上所有的 Linux（其他發行版和裡面正在
# 跑的程式），所以只有明確回答 y 才執行（leader 2026-10-20：安裝程式絕不在沒有 y 的情況下執行它）。
# 不開 Ubuntu 的設定視窗：那個視窗會要你建立 Linux 使用者和密碼，而我們本來就以 root 執行。
# 回傳 'ready'、'failed'（試過了還是不行），或 'declined'（不同意重新啟動整個 WSL）。
function Test-WslRoot([string]$distro) {
    $r = Invoke-BoundedWsl -Arguments @('-d', $distro, '-u', 'root', '--exec', 'echo', 'WSL_OK')
    if ($r.Code -ne 0 -or $r.Text -notmatch 'WSL_OK') {
        Write-Warn (Get-WslFailureMessage "WSL root probe failed ($distro)" $r)
        return $false
    }
    return $true
}
function Wait-WslRoot([string]$distro, [int]$tries = 3, [int]$pauseSeconds = 5) {
    for ($i = 1; $i -le $tries; $i++) {
        if (Test-WslRoot $distro) { return 'ready' }
        if ($i -lt $tries) {
            Write-Info "$distro 還沒準備好，只重新啟動這個 Linux 後再試一次（$i/$($tries - 1)）..."
            $null = Invoke-BoundedWsl -Arguments @('--terminate', $distro)
            Start-Sleep -Seconds $pauseSeconds
        }
    }
    Write-Host ""
    $answer = Read-Host "  要重新啟動整個 WSL 嗎？這會停掉這台電腦上所有的 Linux（包括其他發行版和裡面正在跑的程式）。(y/N)"
    # 只有一個 y（前後空白可以）才算同意；y/N、yes、yesterday 都不算（#2265 審查）。[string]：沒有輸入可讀時
    # Read-Host 回傳 $null，而 $null -notmatch '…' 不是 $true，會被當成同意。
    if (([string]$answer) -notmatch '^\s*[yY]\s*$') { return 'declined' }
    Write-Info "正在重新啟動整個 WSL..."
    $null = Invoke-BoundedWsl -Arguments @('--shutdown')
    Start-Sleep -Seconds $pauseSeconds
    if (Test-WslRoot $distro) { return 'ready' }
    return 'failed'
}
# ── 另外安裝一個 AgEnD 專用的 Ubuntu（#1853，使用者 2026-10-20 實測後的要求）──────────
# 已經有 Ubuntu 的電腦：建議另外裝一個只給 AgEnD 用的（名稱 AgEnD，被占用就 AgEnD-2、AgEnD-3…），原本的完全不動。
# WSL 2.4.4 以上用 `wsl --install Ubuntu-26.04 --name <名稱> --location <位置> --no-launch`（tar 格式的發行版才能指定
# 名稱，見 Microsoft 文件 build-custom-distro）；較舊的 WSL，或裝完沒看到這個名稱，就從 Microsoft 的發行版清單取官方
# 的 .wsl（比對 SHA256）再 `wsl --import`。選定的名稱記在安裝進度和 install.json，之後的每一步、兩個捷徑、
# agend shortcuts 和修復都用它。之前已經裝過的 AgEnD 專用 Linux 會直接沿用，不會再裝一個。
$AGEND_DISTRO_BASE = 'AgEnD'
$WSL_NAME_MIN = [version]'2.4.4'
$DISTRO_LIST_URL = 'https://raw.githubusercontent.com/microsoft/WSL/master/distributions/DistributionInfo.json'

# 這台電腦上的 Linux 名稱：只看清單，不啟動任何一個。wsl.exe 自己的輸出要設 WSL_UTF8=1 才是 UTF-8（否則 UTF-16LE）。
# 回傳名稱陣列（可能是空的），或 $null：讀不到（#2279 審查）。讀不到絕不能當成「沒有 Linux」——那會不問就安裝、
# 甚至改到原本的 Ubuntu。wsl --list 失敗時（有的版本在一個都沒有時也回非 0）改讀 WSL 自己的登記（HKCU 的 Lxss），兩者都讀不到才是 $null。
function Get-WslDistroNames {
    $prev = $env:WSL_UTF8
    try {
        $env:WSL_UTF8 = '1'
        $r = Invoke-BoundedWsl -Arguments @('--list', '--quiet')
        $out = @($r.Text -split '\r?\n' | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
        if ($r.Code -eq 0) { return ,$out }
    } catch {
        # wsl.exe 不能執行：改讀登記
    } finally {
        if ($null -eq $prev) { Remove-Item Env:WSL_UTF8 -ErrorAction SilentlyContinue } else { $env:WSL_UTF8 = $prev }
    }
    # 先存進變數再用 , 回傳：空陣列（確定一個都沒有）直接 return 會被攤開成沒有輸出，變成 $null（#2279 審查）。
    $registered = Get-WslRegisteredNames
    if ($null -eq $registered) { return $null }
    return ,$registered
}
# WSL 登記的 Linux 名稱（HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss 底下每一個的 DistributionName）。
# 確定沒有這個機碼：一個都沒有（空陣列）。沒有 HKCU 可讀（不是 Windows）或讀取出錯：$null。
function Get-WslRegisteredNames {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    try {
        if (-not (Get-PSDrive -Name HKCU -ErrorAction SilentlyContinue)) { return $null }
        if (-not (Test-Path -LiteralPath $key -ErrorAction Stop)) { return ,@() }
        $names = @(Get-ChildItem -LiteralPath $key -ErrorAction Stop | ForEach-Object { [string](Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop).DistributionName } | Where-Object { $_ })
        return ,$names
    } catch { return $null }
}
# 第 1 階段要做什麼：'unknown'（讀不到清單：停下來）、'reuse'（之前裝過 AgEnD 專用的）、'ubuntu'（有 Ubuntu：問）、
# 'none'（確定一個都沒有：照常安裝）。回傳 @{ State; Agend; Ubuntu }。
function Get-DistroSituation($names) {
    if ($null -eq $names) { return @{ State = 'unknown' } }
    $agend = Get-ExistingAgendDistro $names
    if ($agend) { return @{ State = 'reuse'; Agend = $agend } }
    $ubuntu = @(@('Ubuntu-26.04', 'Ubuntu-24.04', 'Ubuntu-22.04', 'Ubuntu') | Where-Object { $names -contains $_ })[0]
    if ($ubuntu) { return @{ State = 'ubuntu'; Ubuntu = $ubuntu } }
    return @{ State = 'none' }
}
# 第一個沒有被占用的名稱：AgEnD、AgEnD-2、AgEnD-3…（WSL 的名稱不分大小寫）。
function Get-FreeAgendDistroName($names) {
    $taken = @($names | ForEach-Object { ([string]$_).ToLowerInvariant() })
    if ($taken -notcontains $AGEND_DISTRO_BASE.ToLowerInvariant()) { return $AGEND_DISTRO_BASE }
    for ($i = 2; $i -lt 100; $i++) { $n = "$AGEND_DISTRO_BASE-$i"; if ($taken -notcontains $n.ToLowerInvariant()) { return $n } }
    return $null
}
# 之前為 AgEnD 裝過的專用 Linux：安裝紀錄裡那個（名稱是 AgEnD 開頭、而且還在），否則名稱正好是 AgEnD 的。回傳名稱或 $null。
function Get-ExistingAgendDistro($names) {
    $record = Read-InstallRecord
    if ($record -and $record.Distro -like "$AGEND_DISTRO_BASE*" -and ($names -contains $record.Distro)) { return $record.Distro }
    $hit = @($names | Where-Object { $_ -ieq $AGEND_DISTRO_BASE })
    if ($hit.Count -gt 0) { return $hit[0] }
    return $null
}
# 已經有 Ubuntu 時問一次。回傳 'separate'（另外裝一個，建議）、'existing'（用原本的）或 'quit'。只認 1 或 2，其他都是結束。
function Read-DistroChoice([string]$existing) {
    Write-Ok "這台電腦已經有 $existing。"
    Write-Host ""
    Write-Info "  [1] 另外安裝一個 AgEnD 專用的 Ubuntu（建議，不動你原本的）"
    Write-Info "  [2] 用原本的 $existing（會修改它的設定：開啟 systemd、預設以 root 登入、不再把 Windows 的 PATH 帶進 Linux；裡面的檔案不會被刪除）"
    Write-Info "  [Enter] 結束，不動任何東西"
    # "$(…)"：沒有輸入可讀時 Read-Host 回傳的不是字串（[string] 轉型也會得到 $null），內插一定是字串。
    $answer = "$(Read-Host '  請輸入 1 或 2 再按 Enter；直接按 Enter 就結束')".Trim()
    if ($answer -eq '1') { return 'separate' }
    if ($answer -eq '2') { return 'existing' }
    return 'quit'
}
# Microsoft 發行版清單裡所選 Ubuntu 版本的官方 .wsl（這台電腦的架構）：@{ Url; Sha256 }，拿不到就 $null。
function Get-UbuntuWslImage([string]$version = 'Ubuntu-26.04') {
    try { $list = Invoke-RestMethod -Uri $DISTRO_LIST_URL -TimeoutSec 30 -UseBasicParsing } catch { return $null }
    $entry = @($list.ModernDistributions.Ubuntu | Where-Object { $_.Name -eq $version })[0]
    if (-not $entry) { return $null }
    $image = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $entry.Arm64Url } else { $entry.Amd64Url }
    if (-not $image -or -not $image.Url -or -not $image.Sha256) { return $null }
    return @{ Url = [string]$image.Url; Sha256 = (([string]$image.Sha256) -replace '^0x', '').ToUpperInvariant() }
}
# 新安裝依序試 26.04、24.04；專用 Linux 保留 $name，普通新安裝用實際版本名稱。
# 只有確認沒有建立目標時才換版本；逾時、不明結果與 SHA256 不符都停止。$InstalledName 供接續與捷徑記下實際名稱。
function Install-AgendDistro([string]$name, [string]$location, [switch]$UseVersionName, [ref]$InstalledName) {
    $version = Get-InstalledWslVersion
    $candidates = @('Ubuntu-26.04', 'Ubuntu-24.04')
    # Only an existing saved 22.04 plan may request 22.04; it is never a new-install fallback.
    if ($UseVersionName -and $name -eq 'Ubuntu-22.04') { $candidates = @($name) }
    # A previously saved, not-yet-installed version keeps its plan and location.
    if ($UseVersionName -and $candidates -contains $name) {
        $candidates = @($candidates | Select-Object -Skip ([array]::IndexOf($candidates, $name)))
    }
    foreach ($candidate in $candidates) {
        $target = if ($UseVersionName) { $candidate } else { $name }
        if ($candidate -ne $candidates[0]) {
            Write-Warn ("{0} 無法安裝，改試 {1}；既有的 Linux 不會遷移。 / Previous Ubuntu unavailable; trying {1}. Existing installs are not migrated." -f $previous, $candidate)
        }
        if ($version -and $version -ge $WSL_NAME_MIN) {
            $installCode = Invoke-Watched -Label "下載並安裝 $candidate（$target）" -Usually "通常需要 3–10 分鐘" -UpperMinutes 15 -TimeoutSeconds 1800 -NoProgressSeconds 0 -Encoding utf16 -File "wsl.exe" -Arguments @("--install", $candidate, "--name", $target, "--location", $location, "--no-launch")
            $after = Get-WslDistroNames
            if ($null -eq $after) { Write-Err "裝完之後讀不到 Linux 清單，無法確認 $target 有沒有裝好；沒有再做任何事。"; return $false }
            if ($after -contains $target) {
                if ($installCode -notin @(0,3010)) { Write-Err "Linux 安裝結束碼 $installCode，尚未標記完成；請重新執行以驗證現況。"; return $false }
                if ($InstalledName) { $InstalledName.Value = $target }
                Write-Ok "已安裝 $candidate（WSL 名稱：$target）。 / Installed $candidate (WSL name: $target)."
                return $true
            }
            if ($installCode -eq 124) { Write-Err 'Linux installation timed out; check WSL before retrying.'; return $false }
            Write-Warn "$candidate 未透過 WSL 安裝，改試官方映像檔（$target）。"
        }
        $previous = $candidate
        $image = Get-UbuntuWslImage $candidate
        if (-not $image) { Write-Warn "拿不到 $candidate 的官方映像檔（可能是版本或網路問題）。 / Official $candidate image unavailable."; continue }
        $file = Join-Path ([IO.Path]::GetTempPath()) ("agend-ubuntu-" + [Guid]::NewGuid().ToString('N') + ".wsl")
        $prevProgress = $ProgressPreference
        try {
            Write-Info "正在下載官方的 $candidate（幾百 MB，請稍候）... / Downloading official $candidate..."
            $ProgressPreference = 'SilentlyContinue'
            try { Invoke-InstallDownload -Uri $image.Url -OutFile $file -TimeoutSec 1800 } catch { Write-Warn "下載 $candidate 失敗：$_"; continue }
            $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
            # A failed integrity check is never a reason to try another image.
            if ($hash -ne $image.Sha256) { Write-Err "下載的 Ubuntu 和官方的檢查碼不符，沒有安裝。"; return $false }
            New-Item -ItemType Directory -Path $location -Force | Out-Null
            $importCode = Invoke-Watched -Label "匯入 $candidate（$target）" -Usually "通常需要 1–3 分鐘" -UpperMinutes 10 -TimeoutSeconds 1800 -NoProgressSeconds 0 -Encoding utf16 -File "wsl.exe" -Arguments @("--import", $target, $location, $file, "--version", "2")
            $after = Get-WslDistroNames
            if ($null -eq $after -or $importCode -eq 124) { Write-Err 'Linux import outcome is unconfirmed; check WSL before retrying.'; return $false }
            if ($after -contains $target) {
                if ($importCode -notin @(0,3010)) { Write-Err "Linux 匯入結束碼 $importCode，請重新執行以驗證現況。"; return $false }
                if ($InstalledName) { $InstalledName.Value = $target }
                Write-Ok "已安裝 $candidate（WSL 名稱：$target）。 / Installed $candidate (WSL name: $target)."
                return $true
            }
        } finally {
            $ProgressPreference = $prevProgress
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Err "$($candidates -join '、') 都沒有安裝成功；請確認網路與 WSL 狀態後重試。 / Ubuntu installation failed for $($candidates -join ', '); check the network and WSL, then retry."
    return $false
}

# 沒有同意重新啟動整個 WSL：乾淨地停下來，說明之後怎麼繼續（重新執行同一行安裝指令會從這一步接著做）。
function Write-WslDeclined {
    Write-Warn "沒有重新啟動 WSL，所以先停在這裡；你的其他 Linux 都沒有被動到。"
    Write-Info "  之後可以重新開機 Windows，或晚一點再貼一次同一行安裝指令，它會從這一步繼續。"
}

# ── 登入 AI 後端（#1853：使用者核准的第 ③ 步）──────────────────────────
# 登入網址自動在 Windows 的瀏覽器打開：WSL 裡的 BROWSER 指向 /usr/local/bin/agend-open-url，用 Windows 的 explorer.exe
# 開網址（WSL interop）。有獨立登入指令的後端用那個指令，登入完成它就自己結束。Antigravity 沒有，就在專用的 tmux 裡跑 agy：
# 等憑證檔寫完（連續 3 秒不再變動）、agy models 確認能用、畫面回到可輸入的提示，才送它自己的 /quit。
# 絕不在登入中途結束它，也絕不強制終止；送了 /quit 它沒結束，就留給使用者。指令與判斷和 fleet 的 /login 一致（src/login-flows.ts）。
$AGY_TOKEN = '/root/.gemini/antigravity-cli/antigravity-oauth-token'
function Get-WindowsExplorerWslPath {
    $root = $env:SystemRoot; if (-not $root) { $root = 'C:\Windows' }
    return ('/mnt/' + $root.Substring(0, 1).ToLower() + ($root.Substring(2) -replace '\\', '/') + '/explorer.exe')
}
function Get-WindowsPowerShellWslPath {
    $root = $env:SystemRoot; if (-not $root) { $root = 'C:\Windows' }
    return ('/mnt/' + $root.Substring(0, 1).ToLower() + ($root.Substring(2) -replace '\\', '/') + '/System32/WindowsPowerShell/v1.0/powershell.exe')
}
function Get-LoginCommand([string]$key) {
    switch ($key) {
        'kiro' { return 'kiro-cli login' }
        'claude' { return 'claude auth login' }
        # --device-auth: a code shown here and entered in the browser. Plain `codex login` waits on 127.0.0.1:1455 inside WSL,
        # which only works when WSL forwards localhost to Windows (the browser sign-in uses --device-auth too).
        'codex' { return 'codex login --device-auth' }
        'antigravity' { return 'agend_agy_login' }
    }
    return $null
}
# 已登入時結束碼 0（和 fleet 的 authCheck 相同）。
function Get-LoginCheck([string]$key) {
    switch ($key) {
        'kiro' { return 'kiro-cli whoami --format json >/dev/null 2>&1' }
        'claude' { return "claude auth status 2>/dev/null | grep -Eq '`"loggedIn`":[[:space:]]*true'" }
        'codex' { return 'codex login status >/dev/null 2>&1' }
        'antigravity' { return 'agy models >/dev/null 2>&1' }
    }
    return 'false'
}
# agy 的登入：tmux 用專用的 socket（agend-install，不碰其他 tmux）；上次中斷留下的同名 session 就接回去，不殺掉重開。
$AGY_LOGIN_SH = @'
agend_agy_quit_when_logged_in() {
  # $1 憑證檔、$2 tmux socket、$3 session。憑證檔連續 3 秒沒有變動（inode、大小、修改時間和內容的 checksum 都相同；
  # 只比大小會漏掉等長的覆寫，#2239 審查）、agy models 成功、畫面回到提示，才送 /quit。檔案不見或讀不到就重新計算。
  token="$1"; sock="$2"; sess="$3"; last=""; same=0
  while tmux -L "$sock" has-session -t "$sess" 2>/dev/null; do
    fp=""
    if [ -s "$token" ]; then
      st=$(stat -c '%i %s %y' "$token" 2>/dev/null) && ck=$(cksum < "$token" 2>/dev/null) && fp="$st $ck"
    fi
    if [ -n "$fp" ] && [ "$fp" = "$last" ]; then same=$((same + 1)); else same=0; fi
    last="$fp"
    if [ -n "$fp" ] && [ "$same" -ge 3 ] && agy models >/dev/null 2>&1 \
      && tmux -L "$sock" capture-pane -p -t "$sess" | grep -Eq '\? for shortcuts|^>[[:space:]]*$'; then
      # agy models 和讀畫面都要等：等的時候 token 可能又被寫入（#2239 審查）。送出前再取一次指紋，不同就重新計算。
      now=""
      st=$(stat -c '%i %s %y' "$token" 2>/dev/null) && ck=$(cksum < "$token" 2>/dev/null) && now="$st $ck"
      if [ -n "$now" ] && [ "$now" = "$fp" ]; then
        tmux -L "$sock" send-keys -t "$sess" '/quit' Enter
        return 0
      fi
      same=0; last="$now"
    fi
    sleep 1
  done
  return 0
}
agend_agy_login() {
  command -v tmux >/dev/null 2>&1 || apt-get install -y -qq tmux >/dev/null 2>&1
  if ! tmux -L agend-install has-session -t agy-login 2>/dev/null; then
    tmux -L agend-install new-session -d -s agy-login "BROWSER=$BROWSER PATH=$PATH agy"
  fi
  agend_agy_quit_when_logged_in "$AGY_TOKEN" agend-install agy-login &
  tmux -L agend-install attach -t agy-login
  wait
}
'@
# 一個後端的登入腳本（在 WSL 裡以 root、接在這個視窗上執行）。
function Get-LoginScript([string]$key) {
    $lines = @(
        'export PATH=/root/.local/bin:$HOME/.claude/local:$PATH'
        'export BROWSER=/usr/local/bin/agend-open-url'
        ('AGY_TOKEN=' + $AGY_TOKEN)
    )
    if ($key -eq 'antigravity') { $lines += $AGY_LOGIN_SH }
    $lines += (Get-LoginCommand $key)
    return ($lines -join "`n")
}
# 在 WSL 裡打開網址用的小腳本（BROWSER 指向它）。
function Get-OpenUrlScript {
    return @(
        "cat > /usr/local/bin/agend-open-url <<'SH'"
        '#!/bin/sh'
        '# AgEnD 安裝程式：在 Windows 的瀏覽器打開網址（登入用）。'
        '# 網址交給 Windows 的 Start-Process（經由環境變數，任何字元都原樣到達）。explorer.exe 曾把 Codex 的登入網址開成'
        '# 「文件」資料夾（使用者實測），只在前兩種都打不開時才用它。'
        'if command -v wslview >/dev/null 2>&1 && wslview "$1" >/dev/null 2>&1; then exit 0; fi'
        ('AGEND_OPEN_URL="$1" WSLENV="${WSLENV:+$WSLENV:}AGEND_OPEN_URL" ' + "'" + (Get-WindowsPowerShellWslPath) + "'" + " -NoProfile -NonInteractive -Command 'Start-Process -FilePath `$env:AGEND_OPEN_URL' >/dev/null 2>&1 && exit 0")
        ("'" + (Get-WindowsExplorerWslPath) + "' " + '"$1" >/dev/null 2>&1')
        'exit 0'
        'SH'
        'chmod 755 /usr/local/bin/agend-open-url'
    ) -join "`n"
}
# 安裝完成後補登入的指令（給人貼回 PowerShell）。bash 的程式用 PowerShell 的單引號包住，$HOME、$PATH 原樣交給 Linux，
# 不會先被 PowerShell 展開（#2239 審查）。
function Get-LoginFollowUpCommand([string]$key) {
    $cmd = if ($key -eq 'antigravity') { 'agy' } else { Get-LoginCommand $key }
    return ("wsl -d {0} -u root -- bash -lc 'export PATH=/root/.local/bin:`$HOME/.claude/local:`$PATH; {1}'" -f $UBUNTU_DISTRO, $cmd)
}
# 設定頁要求「在主機上確認」時（#2650 第 1 項）：在 WSL 裡執行 agend settings confirm 的那行指令（給人貼到另一個 PowerShell
# 視窗）。確認一定要有人在這台電腦上看過內容、輸入 y：網頁自己做不到，安裝程式也不代答。編號只接受 32 位小寫十六進位。
function Get-HostConfirmCommand([string]$id) {
    if ($id -cnotmatch '^[0-9a-f]{32}\z') { throw 'Invalid confirmation id' }
    $command = Get-WslAgendCommand ('agend settings confirm ' + $id)
    return ("wsl -d {0} -u {1} --exec bash -lc {2}" -f (ConvertTo-PsArgument $UBUNTU_DISTRO), (ConvertTo-PsArgument $AGEND_USER), (ConvertTo-PsLiteral $command))
}
# #2233：設定頁選了「Web only (no bot)」嗎？問 AgEnD 自己（agend validate --connections 解析 fleet.yaml，和 fleet 讀的一樣），
# 不用 grep 猜。回傳 'web'（0 個連線）、'chat'（有連線）或 'unknown'（讀不到、舊版沒有這個選項、WSL 沒回應）——不知道就不說「已串接」。
# 傳給 wsl 的指令裡沒有雙引號：Windows PowerShell 5.1 傳原生參數時會把內嵌的雙引號弄掉（#2261 審查）。
function Get-FleetConnections([string]$distro) {
    $text = ''
    $prevEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = Invoke-AgendInWsl $distro 'root' 'agend validate --connections'
        if ($result.Code -eq 0) { $text = $result.Text }
    } catch {
        $text = ''
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    if ($text -match '(?m)^CONNECTIONS=(\d+)\s*$') { if ([int]$Matches[1] -eq 0) { return 'web' } else { return 'chat' } }
    return 'unknown'
}
function Test-WslLogin([string]$key) {
    $r = Invoke-BoundedWsl -Arguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--exec', 'bash', '-lc', ('export PATH=/root/.local/bin:$HOME/.claude/local:$PATH; if ' + (Get-LoginCheck $key) + '; then echo LOGIN_OK; else echo LOGIN_NO; fi'))
    return ($r.Code -eq 0 -and $r.Text -match 'LOGIN_OK')
}

# 第 3 階段：逐一登入所選的後端。回傳沒有登入就跳過的後端；有任何一個跳過，這一階段就不算完成（#2239 審查），
# 中斷後接續時會再檢查一次（已登入的跳過、沒登入的再請你登入）。
function Invoke-LoginStage($backends) {
    $skipped = @()
    # 登入網址在 Windows 的瀏覽器打開（見 Get-LoginScript）。
    $null = Invoke-WslStep -Label "準備登入" -Usually "通常幾秒鐘" -UpperMinutes 1 -Script (Get-OpenUrlScript)
    foreach ($b in $backends) {
        Write-Host ""
        if (Test-WslLogin $b.Key) { Write-Ok ("{0} 已經登入，跳過" -f $b.Name); continue }
        $loggedIn = $false
        while (-not $loggedIn) {
            Write-Warn "═══════════════════════════════════════════════════════"
            Write-Warn ("  登入 {0}" -f $b.Name)
            Write-Warn ""
            switch ($b.Key) {
                "kiro" {
                    Write-Warn "  瀏覽器會打開登入頁，用 AWS Builder ID / GitHub / Google 登入並授權。"
                    Write-Warn "  畫面上如果要你選登入方式：用上下方向鍵選，按 Enter。完成後這裡會自動繼續。"
                    Write-Warn "  沒有 AWS Builder ID？先到 https://profile.aws.amazon.com/ 註冊"
                }
                "claude" {
                    Write-Warn "  瀏覽器會打開 Anthropic 的登入頁；登入並授權後，網頁會給你一段代碼。"
                    Write-Warn "  把代碼複製下來，回到這個視窗按一下右鍵貼上，再按 Enter。完成後這裡會自動繼續。"
                }
                "codex" { Write-Warn "  瀏覽器會打開 ChatGPT 的登入頁；登入後這裡會自動繼續。" }
                "antigravity" {
                    Write-Warn "  畫面會顯示 Google 的登入網址和一組代碼：在瀏覽器打開網址、輸入代碼並登入。"
                    Write-Warn "  登入完成、Antigravity 準備好之後，安裝程式會自動幫你結束它，不用按任何鍵。"
                }
            }
            Write-Warn ""
            Write-Warn "  瀏覽器沒有自己打開：用滑鼠選取畫面上的網址，按右鍵複製，再貼到瀏覽器。"
            Write-Warn "  登入時請不要按 Ctrl+C：它會直接關掉登入程式。"
            Write-Warn "═══════════════════════════════════════════════════════"
            Write-Host ""
            $loginFile, $loginWsl = New-WslScriptFile (Get-LoginScript $b.Key)
            # 登入程式直接接在這個視窗上；不能在函式裡直接執行 wsl，它的輸出會進到函式的回傳值。
            try { Start-Process -FilePath 'wsl.exe' -NoNewWindow -Wait -ArgumentList (Join-ProcessArguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--exec', 'bash', $loginWsl)) } catch { }
            Remove-Item -LiteralPath $loginFile -Force -ErrorAction SilentlyContinue
            if (Test-WslLogin $b.Key) {
                Write-Ok ("{0} 登入成功" -f $b.Name)
                $loggedIn = $true
            } else {
                Write-Warn ("{0} 還沒有登入。" -f $b.Name)
                $again = Read-Host "  按 Enter 再試一次；輸入 s 再按 Enter 先跳過（安裝完成時會告訴你怎麼補登入）"
                if ($again -match '^\s*[sS]') { Write-Info ("已跳過 {0}" -f $b.Name); $skipped += $b; break }
            }
        }
    }
    return $skipped                                                     # callers wrap it: @(...)
}
function Complete-LoginStage($backends) {
    $skipped = @(Invoke-LoginStage $backends)
    if ($skipped.Count -eq 0) { Mark-Stage 3 }
    else { Write-Warn ("還沒登入：" + (($skipped | ForEach-Object { $_.Name }) -join "、") + "。之後接續安裝時會再請你登入；已登入的會跳過。") }
    return $skipped                                                     # callers wrap it: @(...)
}

# ── 安裝完成後：打開網頁儀表板、桌面捷徑（#1853：使用者核准的第 ④ 步）──────────
# 儀表板用一次性登入碼登入（不會放在網址裡）：在 WSL 裡執行 agend web --code 取得登入頁和登入碼，在 Windows 的瀏覽器打開
# 登入頁，把登入碼放進剪貼簿並放大顯示。桌面上的「AgEnD 儀表板」捷徑做同一件事，所以之後不用再打任何指令。
# 這段函式的文字同時是捷徑執行的腳本：安裝程式和捷徑用的是同一份。
# 從這裡（$WSL_COMMAND_FN）到 Install-AgendShortcuts 結束，和 templates/windows-shortcuts.ps1 一字不差（WSL 裡的 agend shortcuts
# 用它）：兩邊一起改。
# 兩個捷徑送進 WSL 的指令都用這裡組（#2252 審查）：agend 可能是 nvm 裝的，登入 shell 不一定載入 nvm，所以先補上 PATH 和 nvm。
# 指令裡不放雙引號：Windows PowerShell 5.1 傳給 wsl.exe 的參數不會跳脫內含的雙引號，指令會被拆開。印給人貼上的
# 「啟動 AgEnD」指令也用同一個組法，貼上就能用。
$WSL_COMMAND_FN = @'
function Invoke-BoundedWsl {
param([string[]]$Arguments, [int]$TimeoutSeconds=30)
$sep=[array]::IndexOf($Arguments, '--exec')
if ($sep -ge 0 -and $Arguments.Length -gt ($sep + 1) -and $Arguments[$sep + 1] -eq 'bash') {
$Arguments=@($Arguments[0..$sep]) + @('timeout', '--signal=TERM', '--kill-after=2s', [string]([Math]::Max(1, $TimeoutSeconds - 5))) + @($Arguments[($sep + 1)..($Arguments.Length - 1)])
}
$p=New-Object Diagnostics.Process
$p.StartInfo.FileName='wsl.exe'
$p.StartInfo.Arguments=(@($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
$p.StartInfo.UseShellExecute=$false;$p.StartInfo.CreateNoWindow=$true
$p.StartInfo.EnvironmentVariables['WSL_UTF8']='1'
$p.StartInfo.StandardOutputEncoding=[Text.Encoding]::UTF8;$p.StartInfo.StandardErrorEncoding=[Text.Encoding]::UTF8
$p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true;$p.StartInfo.RedirectStandardInput=$true
try {
$null=$p.Start();$p.StandardInput.Close()
$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
$p.Kill();$null=$p.WaitForExit(10000)
return @{Code=124;Text='WSL timed out;check it before retrying.'}
}
if (-not $out.Wait(1000) -or -not $err.Wait(1000)) { return @{Code=1;Text='WSL output did not close.'} }
$text=$out.Result + $err.Result
if ($text.Length -gt 1MB) { return @{Code=1;Text='WSL output exceeded its limit.'} }
return @{Code=$p.ExitCode;Text=$text}
} catch { return @{Code=-1;Text=[string]$_} }
finally { $p.Dispose() }
}
function Get-WslAgendCommand([string]$command) {
  return ('export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; ' + $command)
}
function ConvertTo-PsLiteral([string]$value) { return ("'" + ($value -replace "'", "''") + "'") }
function ConvertTo-PsArgument([string]$value) { if ($value -match '^[\w.-]+$') { return $value } else { return (ConvertTo-PsLiteral $value) } }
function Get-AgendStartHint([string]$distro, [string]$user) {
  return ("wsl -d {0} -u {1} -- bash -lc '{2}'" -f (ConvertTo-PsArgument $distro), (ConvertTo-PsArgument $user), (Get-WslAgendCommand 'agend start'))
}
'@
. ([scriptblock]::Create($WSL_COMMAND_FN))
$DASHBOARD_OPENER_FN = @'
function Get-DashboardSignIn([string]$text) {
  $url = [regex]::Match($text, 'Sign-in page:\s*(https?://\S+)')
  $code = [regex]::Match($text, 'Code:\s*([A-Z2-7]{4}-?[A-Z2-7]{4})\b')
  if (-not $url.Success -or -not $code.Success) { return $null }
  return @{ Url = $url.Groups[1].Value; Code = $code.Groups[1].Value }
}
function Invoke-OpenDashboard([string]$distro, [string]$user = 'root', [switch]$Wait, [string]$BackendSignins = '') {
  $command = 'agend web --code'
  if ($BackendSignins) {
      if ($BackendSignins -cnotmatch '^(kiro-cli|claude-code|codex|antigravity)(,(kiro-cli|claude-code|codex|antigravity)){0,3}\z') { throw 'Invalid backend selection' }
      $command += ' --backend-signins ' + $BackendSignins
  }
  $text = ''; $exit = 1
  $prevEAP = $ErrorActionPreference
  try {
      $ErrorActionPreference = 'Continue'
      $r = Invoke-BoundedWsl -Arguments @('-d', $distro, '-u', $user, '--exec', 'bash', '-lc', (Get-WslAgendCommand $command))
      $text = $r.Text; $exit = $r.Code
  } catch {
      $text = "$_"; $exit = 1
  } finally {
      $ErrorActionPreference = $prevEAP
  }
  $signIn = if ($exit -eq 0) { Get-DashboardSignIn $text } else { $null }
  if (-not $signIn) {
      Write-Host "  [!!] 現在打不開 AgEnD 儀表板：AgEnD 可能還沒啟動。" -ForegroundColor Yellow
      Write-Host ("  稍等一下再試一次；或在 PowerShell 執行：" + (Get-AgendStartHint $distro $user))
      if ($Wait) { Read-Host "按 Enter 關閉" }
      return $false
  }
  $copied = $false; try { Set-Clipboard -Value $signIn.Code; $copied = $true } catch { }
  $opened = $false; try { Start-Process $signIn.Url; $opened = $true } catch { }
  $spaced = ($signIn.Code.ToCharArray() | ForEach-Object { [string]$_ }) -join ' '
  Write-Host ""
  Write-Host ("  ┌──────────────────────────────────────┐") -ForegroundColor Green
  Write-Host ("  │   儀表板登入碼：  " + $spaced + "    │") -ForegroundColor Green
  Write-Host ("  └──────────────────────────────────────┘") -ForegroundColor Green
  if ($opened) { Write-Host "  [OK] 登入頁已在瀏覽器打開。" -ForegroundColor Green }
  Write-Host ("  登入頁網址：" + $signIn.Url)
  if ($copied) { Write-Host "  [OK] 登入碼已複製：在登入頁的輸入框按 Ctrl+V。這組登入碼只能用一次，幾分鐘內有效。" -ForegroundColor Green }
  else { Write-Host "  在登入頁輸入上面的登入碼。這組登入碼只能用一次，幾分鐘內有效。" }
  if ($Wait) { Read-Host "按 Enter 關閉" }
  return $true
}
'@
. ([scriptblock]::Create($DASHBOARD_OPENER_FN))
$RESTART_FN = @'
function Invoke-AgendInWsl([string]$distro, [string]$user, [string]$command) {
  $prevEAP = $ErrorActionPreference; $prevEnc = [Console]::OutputEncoding
  try {
      $ErrorActionPreference = 'Continue'
      try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
      $limit = if ($command -match '^agend (restart|start)( |$)') { 360 } else { 30 }
      return (Invoke-BoundedWsl -TimeoutSeconds $limit -Arguments @('-d', $distro, '-u', $user, '--exec', 'bash', '-lc', (Get-WslAgendCommand $command)))
  } catch {
      return @{ Code = -1; Text = "$_" }
  } finally {
      $ErrorActionPreference = $prevEAP
      try { [Console]::OutputEncoding = $prevEnc } catch { }
  }
}
function Invoke-RestartAgend([string]$distro, [string]$user, [switch]$Wait, [int]$SettleSeconds = 3) {
  Write-Host ""
  $answer = Read-Host "  確定要重啟 AgEnD 嗎？所有 Agent 會重新啟動，正在進行的工作會中斷。(y/N)"
  if (([string]$answer) -notmatch '^\s*[yY]\s*$') {
      Write-Host "  沒有重啟。"
      if ($Wait) { $null = Read-Host "按 Enter 關閉" }
      return 'cancelled'
  }
  $r = Invoke-AgendInWsl $distro $user 'agend restart'
  $result = 'restarted'
  if ($r.Code -eq 0) {
      Write-Host "  [OK] AgEnD 正在重新啟動。" -ForegroundColor Green
  } else {
      $result = 'failed'
      if ($r.Code -eq -1) { Write-Host "  [!!] 找不到 WSL（wsl.exe），所以沒有重啟。" -ForegroundColor Yellow }
      elseif ($r.Text -match 'Fleet not running') { Write-Host ("  [!!] AgEnD 沒有在執行，所以沒有可以重啟的。要啟動它：" + (Get-AgendStartHint $distro $user)) -ForegroundColor Yellow }
      elseif ($r.Text -match 'command not found|agend: not found|no such file') { Write-Host ("  [!!] 在 {0} 裡找不到 AgEnD（agend 指令），所以沒有重啟。" -f $distro) -ForegroundColor Yellow }
      else { Write-Host ("  [!!] 沒有重啟成功：{0} 不存在、WSL 沒有啟動，或 AgEnD 回報了錯誤。" -f $distro) -ForegroundColor Yellow }
      if ($r.Text.Trim()) { Write-Host ("  " + ($r.Text.Trim() -replace "`r?`n", "`n  ")) }
  }
  if ($result -eq 'restarted') {
      Start-Sleep -Seconds $SettleSeconds
      Write-Host ""
      $s = Invoke-AgendInWsl $distro $user 'agend status'
      if ($s.Text.Trim()) { Write-Host ("  " + ($s.Text.Trim() -replace "`r?`n", "`n  ")) }
  }
  if ($Wait) { $null = Read-Host "按 Enter 關閉" }
  return $result
}
'@
. ([scriptblock]::Create($RESTART_FN))
function Get-ShortcutTargetLine([string]$distro, [string]$user) {
  return ('Write-Host ("AgEnD（Linux：{0}，使用者：{1}）" -f ' + (ConvertTo-PsLiteral $distro) + ', ' + (ConvertTo-PsLiteral $user) + ')')
}
function Get-DashboardOpenerScript([string]$distro, [string]$user) {
  return ("# AgEnD 儀表板（AgEnD 安裝程式建立）`n" + (Get-ShortcutTargetLine $distro $user) + "`n" + $WSL_COMMAND_FN + "`n" + $DASHBOARD_OPENER_FN + "`n" + ("Invoke-OpenDashboard {0} {1} -Wait | Out-Null" -f (ConvertTo-PsLiteral $distro), (ConvertTo-PsLiteral $user)) + "`n")
}
function Get-RestartScript([string]$distro, [string]$user) {
  return ("# AgEnD 重新啟動（AgEnD 安裝程式建立）`n" + (Get-ShortcutTargetLine $distro $user) + "`n" + $WSL_COMMAND_FN + "`n" + $RESTART_FN + "`n" + ("Invoke-RestartAgend {0} {1} -Wait | Out-Null" -f (ConvertTo-PsLiteral $distro), (ConvertTo-PsLiteral $user)) + "`n")
}
function Get-AgendShortcutDir { return (Join-Path $env:LOCALAPPDATA 'AgEnD') }
function Read-InstallRecord {
  try {
      $r = Get-Content -Raw -LiteralPath (Join-Path (Get-AgendShortcutDir) 'install.json') -ErrorAction Stop | ConvertFrom-Json
      if ($r.distro -and $r.user) { return @{ Distro = [string]$r.distro; User = [string]$r.user } }
  } catch { }
  return $null
}
function Get-InstallRecordConflict([string]$distro, [string]$user) {
  $record = Read-InstallRecord
  if ($record -and ($record.Distro -ne $distro -or $record.User -cne $user)) { return $record }
  return $null
}
function Test-InstallRecordAsSeen($seen, [string]$distro, [string]$user) {
  $now = Get-InstallRecordConflict $distro $user
  if ($null -eq $now) { return $true }
  return ($null -ne $seen -and $now.Distro -eq $seen.Distro -and $now.User -ceq $seen.User)
}
function Get-ShortcutCommand([string]$file) {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $a = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $file
  $wt = $null; if ($env:AGEND_INSTALL_TERMINAL -ne 'conhost') { $wt = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if ($wt) { return @{ Target = $wt.Source; Arguments = '-w new "{0}" {1}' -f $ps, ($a -replace ';', '\;') } }
  return @{ Target = $ps; Arguments = $a }
}
function Save-AgendIcon([string]$name, $bytes) {
  if (-not $bytes) { return $null }
  try {
      New-Item -ItemType Directory -Path (Get-AgendShortcutDir) -Force | Out-Null
      $path = Join-Path (Get-AgendShortcutDir) $name
      [IO.File]::WriteAllBytes($path, [byte[]]$bytes)
      return $path
  } catch { return $null }
}
function New-AgendShortcut([string]$name, [string]$scriptName, [string]$scriptText, [string]$description, [string]$icon = '') {
  $dir = Get-AgendShortcutDir
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $file = Join-Path $dir $scriptName
  [IO.File]::WriteAllText($file, $scriptText, (New-Object System.Text.UTF8Encoding $true))
  $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($name + '.lnk')
  $staged = $lnk + '.agend-new'
  # WScript.Shell saves a shortcut through the system ANSI code page: on a Windows whose system language has no 儀表板
  # (English, Japanese...) Save() on the Chinese name fails. So it is saved under an ASCII name here, then put in place
  # by .NET (Unicode). Leftovers of a run that died midway are ours by name, and only those are removed.
  Get-ChildItem -LiteralPath $dir -Filter 'shortcut-*.tmp.lnk' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) }
  $tmp = Join-Path $dir ('shortcut-' + [guid]::NewGuid().ToString('N') + '.tmp.lnk')
  try {
      $shell = New-Object -ComObject WScript.Shell
      $sc = $shell.CreateShortcut($tmp)
      $cmd = Get-ShortcutCommand $file
      $sc.TargetPath = $cmd.Target
      $sc.Arguments = $cmd.Arguments
      $sc.Description = $description
      if ($icon) { $sc.IconLocation = $icon + ',0' }
      $sc.Save()
      # Beside the old one first (same folder, same volume), then swapped in: if that fails, the old shortcut stays.
      [IO.File]::Copy($tmp, $staged, $true)
      if ([IO.File]::Exists($lnk)) { [IO.File]::Replace($staged, $lnk, [NullString]::Value) } else { [IO.File]::Move($staged, $lnk) }
  } finally {
      foreach ($left in @($tmp, $staged)) { try { if ([IO.File]::Exists($left)) { [IO.File]::Delete($left) } } catch { } }
  }
  return $lnk
}
function Install-AgendShortcuts([string]$distro, [string]$user, $icons = $null) {
  if (-not $script:OnWindows) { return @() }
  $made = @()
  $dashIcon = ''; $restartIcon = ''
  if ($icons) { $dashIcon = [string](Save-AgendIcon 'agend.ico' $icons['agend.ico']); $restartIcon = [string](Save-AgendIcon 'agend-restart.ico' $icons['agend-restart.ico']) }
  try { $made += New-AgendShortcut 'AgEnD 儀表板' 'open-dashboard.ps1' (Get-DashboardOpenerScript $distro $user) 'AgEnD 網頁儀表板（自動帶入登入碼）' $dashIcon } catch { }
  try { $made += New-AgendShortcut 'AgEnD 重新啟動' 'restart-agend.ps1' (Get-RestartScript $distro $user) '重新啟動 AgEnD（會先詢問）' $restartIcon } catch { }
  try {
      New-Item -ItemType Directory -Path (Get-AgendShortcutDir) -Force | Out-Null
      $record = @{ distro = $distro; user = $user } | ConvertTo-Json -Compress
      [IO.File]::WriteAllText((Join-Path (Get-AgendShortcutDir) 'install.json'), $record, (New-Object System.Text.UTF8Encoding $false))
      if ($made.Count -eq 2) { $null = Invoke-AgendInWsl $distro $user 'set -f; IFS=; d=${AGEND_HOME:-$HOME/.agend}; umask 077; mkdir -p -m 700 -- $d && date -u +%FT%TZ > $d/windows-shortcuts' }
  } catch { }
    return $made
}
# >>> shortcut icons（M-2885：桌面捷徑的圖示，由 scripts/embed-shortcut-icons.mjs 從 templates/icons 寫入；不要手改）
$AGEND_ICONS = @{
  'agend.ico' = [Convert]::FromBase64String('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')
  'agend-restart.ico' = [Convert]::FromBase64String('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')
}
# <<< shortcut icons
# 重新執行安裝指令時：這台電腦是不是已經裝好 AgEnD？先看安裝時記下的，再看預設的 Ubuntu。回傳 @{ Distro; User } 或 $null。
# 只有現在真的有 Store/MSI 版 WSL（看檔案，不執行）時才問 WSL：乾淨的 Windows 上 wsl.exe 會停在「按任意鍵安裝」等按鍵
# （#2228）。安裝紀錄只用來挑 Linux 和使用者，不能代表 WSL 還在：移除 WSL 後紀錄可能還留著（#2252 審查）。
# 一個 Linux 裡的 AgEnD 是什麼狀態（#2264 的後續：更新中斷後 agend 不見了）。agend --version 能執行：AGEND_FOUND。
# 執行不了、但還留著 AgEnD 的東西（fleet.yaml，或 npm 全域目錄裡的 @songsid，包括中斷的安裝移到旁邊的 .agend-*）：
# AGEND_BROKEN，並帶回磁碟上找得到的版本（AGEND_VERSION=…，修復時用它選 beta 或正式版的通道）。兩者都不是：什麼都不印。
# 只有 @songsid 這個資料夾不算：要有 AgEnD 自己的 package.json（#2286 審查）。指令裡不能放雙引號（Windows PowerShell
# 5.1），所以用 set -f 和 IFS= 讓路徑裡的空白和萬用字元不被拆開，只有找 .agend-* 的那段暫時打開萬用字元；空值用
# [ x$v = x ] 判斷（不加引號的 [ -n $v ] 在空值時會是真）。
$AGEND_PROBE = 'set -f; IFS=; if agend --version >/dev/null 2>&1; then echo AGEND_FOUND; else r=$(npm root -g 2>/dev/null); r=${r:-/nonexistent}; h=${AGEND_HOME:-$HOME/.agend}; v=; p=; set +f; for f in $r/@songsid/agend/package.json $r/@songsid/.agend-*/package.json; do if [ -f $f ]; then p=1; [ x$v != x ] || v=$(sed -n ''s/^[[:space:]]*.version.:[[:space:]]*.\([0-9][0-9A-Za-z.+-]*\).,*[[:space:]]*$/\1/p'' $f | head -1); fi; done; set -f; if [ -f $h/fleet.yaml ] || [ x$p = x1 ]; then echo AGEND_BROKEN; [ x$v = x ] || echo AGEND_VERSION=$v; fi; fi'
# 重新執行安裝指令時：這台電腦是不是已經裝好 AgEnD？先看安裝時記下的，再看 AgEnD 專用的和預設的 Ubuntu。回傳
# @{ Distro; User; Broken; Version } 或 $null。只有現在真的有 Store/MSI 版 WSL 時才問 WSL（#2228、#2252 審查）。
function Find-ExistingAgend {
    if (-not (Get-InstalledWslVersion)) { return $null }
    $record = Read-InstallRecord
    $candidates = @()
    if ($record) { $candidates += ,@($record.Distro, $record.User) }
    foreach ($d in @($AGEND_DISTRO_BASE, 'Ubuntu-26.04', 'Ubuntu-24.04', 'Ubuntu-22.04', 'Ubuntu')) { $candidates += ,@($d, 'root') }
    foreach ($c in $candidates) {
        $r = Invoke-AgendInWsl $c[0] $c[1] $AGEND_PROBE
        if ($r.Code -ne 0) { continue }
        if ($r.Text -match 'AGEND_FOUND') { return @{ Distro = $c[0]; User = $c[1]; Broken = $false } }
        if ($r.Text -match 'AGEND_BROKEN') {
            $v = [regex]::Match($r.Text, 'AGEND_VERSION=([0-9][0-9A-Za-z.+-]*)')
            return @{ Distro = $c[0]; User = $c[1]; Broken = $true; Version = $(if ($v.Success) { $v.Groups[1].Value } else { $null }) }
        }
    }
    return $null
}
# 修復「已安裝但壞掉」的 AgEnD：在那個 Linux 裡重跑官方的安裝指令。它會放回中斷的安裝移走的東西、裝好、證明
# agend --version、重新設定服務；已經設定好的 fleet 不會重新設定，資料和設定都保留（#2264）。磁碟上找到的版本只用來
# 選通道：beta 的就裝目前的 beta，否則裝正式版（#2286 審查：舊版可能還沒有會修復的安裝程式）。修好才回傳 $true。
function Invoke-AgendRepair([string]$distro, [string]$user, [string]$version) {
    $pin = if ($version -match '^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$') { 'AGEND_VERSION=beta ' } else { '' }
    $cmd = Get-WslAgendCommand (Get-AgendInstallShScript $pin)
    $code = Invoke-WslStep -Label "修復 AgEnD" -Usually "通常需要 1–3 分鐘" -UpperMinutes 15 -Distro $distro -User $user -Script $cmd
    if ($code -ne 0) { return $false }
    $after = Invoke-AgendInWsl $distro $user 'agend --version'
    return ($after.Code -eq 0)
}

# #2650 item 6: a runnable CLI alone does not prove that setup/service/auth are ready.
# Opt-in only. Keep the discovered account/distro, and reuse setup's own consent and expiry handling.
function Invoke-ExistingAgendRecovery([string]$distro, [string]$user) {
    $UBUNTU_DISTRO = $distro; $AGEND_USER = $user
    $AGEND_ENV = Get-WslAgendCommand ''
    if (-not (Get-VerifiedAgendVersion)) {
        Write-Err 'AgEnD、Node、tmux 或 SQLite 尚未通過驗證；沒有重設你的設定。'
        Write-Info "需要完整修復依賴時，先執行 `$env:AGEND_INSTALL_FORCE = '1'，再貼上同一行安裝指令；原有設定會保留。"
        Set-InstallFailure 'agend'
        return $false
    }
    if (-not (Test-InstallerReady)) {
        Write-Info '接下來只接續設定與服務；現有設定不會重設。尚未設定完成時會開啟瀏覽器，需要你親自確認。'
        if (-not (Invoke-SetupAndService)) { Set-InstallFailure 'setup'; return $false }
        if (-not (Test-InstallerReady)) {
            Write-Warn '設定已保留，但服務或儀表板仍未就緒；這次不會宣稱修復完成。請看上方錯誤，之後可再選擇檢查／修復。'
            Set-InstallFailure 'service'
            return $false
        }
    }
    Write-Ok '服務與儀表板已驗證就緒；沒有重新安裝 WSL 或 AI 後端。'
    Write-Info '後端尚未登入：打開下方的儀表板，到「設定 → 登入」接續；這裡不會把服務就緒當成登入成功。'
    return $true
}

# 說明捷徑建立的結果：兩個都好、只好一個（說是哪一個）、都沒好。兩個都好時回傳 $true。
function Write-ShortcutResult($made) {
    $names = @($made | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension([string]$_) })
    if ($names.Count -ge 2) { Write-Ok "桌面上已建立「AgEnD 儀表板」和「AgEnD 重新啟動」捷徑"; return $true }
    if ($names.Count -eq 1) { Write-Warn ("只建立了「{0}」捷徑，另一個沒有建立成功。之後可以再貼一次安裝指令重試。" -f $names[0]) }
    else { Write-Warn "桌面捷徑沒有建立成功。之後可以再貼一次安裝指令重試。" }
    return $false
}

# ── WSL 安裝前檢查（#2650 第 7 項）─────────────────────────
# 在動任何東西之前先看清楚：Windows 組建（WSL 2 需要 Windows 10 2004，組建 19041 以上，或 Windows 11）、架構（x64 或
# ARM64；ARM64 要裝 ARM64 版的 WSL）、兩個 Windows 功能（Microsoft-Windows-Subsystem-Linux 和 VirtualMachinePlatform，
# 各看各的），以及虛擬化（BIOS/UEFI 裡的 Intel VT-x / AMD-V）。缺哪個功能就只啟用哪個；DISM 的結束碼要是 0 或 3010
# （成功、需要重新開機），啟用後再讀一次兩個功能的狀態，確定真的啟用（或等重新開機生效）才說已啟用。
$WSL_MIN_BUILD = 19041
$WSL_FEATURES = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')
function Get-WindowsBuild {
    try { return [int](Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).BuildNumber } catch { }
    try { return [Environment]::OSVersion.Version.Build } catch { return $null }
}
# 'x64'、'arm64'，或其他（例如 32 位元的 x86：不支援）。看作業系統的架構，不看這個 PowerShell 行程的。
function Get-WindowsArch {
    $a = $null
    try { $a = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture } catch { }
    if (-not $a) { $a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { [string]$env:PROCESSOR_ARCHITECTURE } }
    switch -regex ($a) { '^(X64|AMD64)$' { return 'x64' } '^ARM64$' { return 'arm64' } }
    return $a.ToLowerInvariant()
}
# 一個 Windows 功能的狀態：'Enabled'、'EnablePending'（已啟用，重新開機後生效）、'Disabled'（含 DisablePending），或
# 'Unknown'（讀不到：例如這台電腦沒有 DISM 的 PowerShell 模組）。
function Get-WslFeatureState([string]$name) {
    try {
        $f = Get-WindowsOptionalFeature -Online -FeatureName $name -ErrorAction Stop
        switch ([string]$f.State) { 'Enabled' { return 'Enabled' } 'EnablePending' { return 'EnablePending' } default { return 'Disabled' } }
    } catch { return 'Unknown' }
}
# 虛擬化：$true（已經有 hypervisor 在跑，或 BIOS/UEFI 已開）、$false（明確沒開），或 $null（看不出來，不下結論）。
function Test-Virtualization {
    try { if ((Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).HypervisorPresent) { return $true } } catch { }
    try {
        $v = @(Get-CimInstance Win32_Processor -ErrorAction Stop | ForEach-Object { $_.VirtualizationFirmwareEnabled })
        if ($v -contains $true) { return $true }
        if ($v.Count -gt 0 -and $v -contains $false) { return $false }
    } catch { }
    return $null
}
function Get-WslPreflight {
    $features = [ordered]@{}
    foreach ($n in $WSL_FEATURES) { $features[$n] = Get-WslFeatureState $n }
    return @{ Build = (Get-WindowsBuild); Arch = (Get-WindowsArch); Features = $features; Virtualization = (Test-Virtualization) }
}
# 組建和架構不行就說明並回傳 $false（不要再往下做）；虛擬化看起來沒開只警告（偵測不一定準，虛擬機裡尤其如此）。
function Test-WslPreflight($pre) {
    if ($pre.Build -and $pre.Build -lt $WSL_MIN_BUILD) {
        Write-Err ("這台電腦的 Windows 太舊（組建 {0}）：WSL 2 需要 Windows 10 2004（組建 {1}）以上，或 Windows 11。" -f $pre.Build, $WSL_MIN_BUILD)
        Write-Info "  請先用 Windows Update 更新 Windows，再執行同一行安裝指令。"
        return $false
    }
    if ($pre.Arch -ne 'x64' -and $pre.Arch -ne 'arm64') {
        Write-Err ("這台電腦的 Windows 是 {0} 版：WSL 2 只支援 64 位元（x64 或 ARM64）的 Windows。" -f $pre.Arch)
        return $false
    }
    if ($pre.Virtualization -eq $false) { Write-VirtualizationHint }
    return $true
}
function Write-VirtualizationHint {
    Write-Warn "這台電腦的虛擬化看起來沒有開啟，WSL 2 需要它。"
    Write-Info "  請到 BIOS/UEFI 設定裡開啟 Intel VT-x（Intel Virtualization Technology）或 AMD-V（SVM Mode），存檔後重新開機。"
    Write-Info "  在虛擬機裡執行時，需要虛擬機軟體開啟「巢狀虛擬化」。公司電腦請洽 IT 人員。"
}
# 啟用缺少的功能。回傳 'ready'（兩個都已啟用）、'reboot'（剛啟用或等待生效，要重新開機），或 'failed'（原因已說明）。
# $features：Get-WslPreflight 讀到的狀態。
function Enable-WslFeatures($features) {
    $needReboot = $false
    foreach ($n in $WSL_FEATURES) {
        $state = $features[$n]
        if ($state -eq 'Enabled') { continue }
        if ($state -eq 'EnablePending') { $needReboot = $true; continue }
        $label = if ($n -eq 'VirtualMachinePlatform') { '啟用虛擬機器平台' } else { '啟用 WSL 功能' }
        $code = Invoke-Watched -Label $label -Usually "通常需要 1–3 分鐘" -UpperMinutes 5 -Encoding oem -File "dism.exe" -Arguments @("/online", "/enable-feature", "/featurename:$n", "/all", "/norestart")
        if ($code -eq 3010) { $needReboot = $true }
        elseif ($code -ne 0) {
            Write-Err ("{0} 沒有成功（DISM 結束碼 {1}）。" -f $label, $code)
            Write-Info "  可能是公司的原則不允許，或 Windows 元件損壞。請洽 IT 人員，或先執行 Windows Update 後再試同一行安裝指令。"
            return 'failed'
        } else { $needReboot = $true }
    }
    # 再讀一次：DISM 說成功不算數，要 Windows 自己說已啟用（或等重新開機）。讀不到（Unknown）就相信結束碼。
    foreach ($n in $WSL_FEATURES) {
        if ($features[$n] -eq 'Enabled') { continue }
        $now = Get-WslFeatureState $n
        if ($now -eq 'Disabled') {
            Write-Err ("{0} 還是沒有啟用。" -f $n)
            Write-Info "  可能是公司的原則不允許。請洽 IT 人員；或打開「開啟或關閉 Windows 功能」手動勾選後重新開機，再執行同一行安裝指令。"
            return 'failed'
        }
    }
    if ($needReboot) { return 'reboot' }
    return 'ready'
}

# ── WSL 更新：已經是 2 以上就不強制更新（#1853：使用者在共用對外 IP 的辦公室實測）──────────
# GitHub 對沒登入的請求，每個 IP 每小時只給 60 次（超過回 403/429）；很多人共用一個對外 IP 時，wsl --update --web-download
# 和下面的 MSI 備案都會被擋。所以：已安裝的 WSL（Store／MSI 版裝在 %ProgramFiles%\WSL\wsl.exe）版本 2.0.0 以上就略過更新；
# 版本只看檔案，不執行 wsl.exe。要更新時先走 Microsoft Store（wsl --update 的預設，不受 GitHub 次數限制），GitHub 只當備案；
# 更新失敗但這台電腦已經有可以用的 WSL，就警告後繼續，不中止。
function Get-FileVersionString([string]$path) {
    try { return (Get-Item -LiteralPath $path -ErrorAction Stop).VersionInfo.FileVersion } catch { return $null }
}
function Get-InstalledWslVersion([string]$ProgramFiles = $env:ProgramFiles) {
    if (-not $ProgramFiles) { return $null }
    $exe = Join-Path (Join-Path $ProgramFiles 'WSL') 'wsl.exe'
    if (-not (Test-Path -LiteralPath $exe)) { return $null }
    $m = [regex]::Match([string](Get-FileVersionString $exe), '^\s*\d+\.\d+(\.\d+){0,2}')
    if (-not $m.Success) { return $null }
    return [version]$m.Value.Trim()
}
function Test-WslCurrent($version) { return ($null -ne $version -and $version -ge [version]'2.0.0') }
# 下載失敗的原因：GitHub 的次數限制、網路（逾時、連不上、被擋），或其他。
function Get-DownloadFailureKind($err) {
    $status = $null
    try { $status = [int]$err.Exception.Response.StatusCode } catch { }
    $text = [string]$err
    if ($status -eq 403 -or $status -eq 429 -or $text -match 'rate limit|\(403\)|\(429\)|\b429\b') { return 'ratelimit' }
    if ($text -match 'timed out|timeout|逾時|could not be resolved|無法解析|unable to connect|無法連線|actively refused|connection was closed') { return 'network' }
    return 'other'
}
function Write-DownloadFailure([string]$kind) {
    switch ($kind) {
        'ratelimit' {
            Write-Warn "GitHub 暫時限制了這個網路的下載次數（很多人共用同一個對外網路時，例如公司網路，很常遇到）。"
            Write-Info "請過一小時左右再執行同一行安裝指令，或換一個網路（例如手機熱點）再試。"
        }
        'network' {
            Write-Warn "連不上 GitHub（逾時、連線失敗，或被防火牆擋住）。"
            Write-Info "請確認網路正常後再執行同一行安裝指令，或換一個網路（例如手機熱點）再試。"
        }
        default { Write-Info ("請稍後再執行同一行安裝指令；也可以手動到 https://github.com/microsoft/WSL/releases 下載 {0} 的 .msi 安裝。" -f (Get-WindowsArch)) }
    }
}
# 第 1 階段的 WSL 更新。回傳：skipped（已是 2 以上）、updated、usable（更新失敗但現有的 WSL 可用）、reboot（MSI 要求重開機）、
# verify-reboot（裝好但要重開機才能用）、failed（不能繼續；原因已經說明）。
function Invoke-WslUpdateStage {
    $installed = Get-InstalledWslVersion
    if (Test-WslCurrent $installed) { Write-Ok ("WSL {0} 已安裝，略過更新" -f $installed); return 'skipped' }
    $seen = @{ RateLimited = $false }
    $watch = { param($line) if ($line -match 'rate limit|\b403\b|\b429\b') { $seen.RateLimited = $true } }
    Write-Info "更新 WSL 核心元件..."
    $code = Invoke-Watched -Label "更新 WSL 核心元件" -Usually "通常需要 1–5 分鐘" -UpperMinutes 8 -Encoding utf16 -File "wsl.exe" -Arguments @("--update")
    if ($code -ne 0) {
        # Microsoft Store 被擋（公司電腦常見）時，改從 GitHub 下載同一個更新。
        Write-Warn "從 Microsoft Store 更新失敗，改從 GitHub 下載..."
        $code = Invoke-Watched -Label "從 GitHub 更新 WSL" -Usually "通常需要 1–5 分鐘" -UpperMinutes 8 -OnLine $watch -Encoding utf16 -File "wsl.exe" -Arguments @("--update", "--web-download")
    }
    if ($code -eq 0) { Write-Ok "WSL 核心已更新"; return 'updated' }
    $now = Get-InstalledWslVersion
    if (Test-WslCurrent $now) {
        Write-Warn ("WSL 更新沒有完成，但這台電腦已經有可以用的 WSL {0}，繼續安裝。" -f $now)
        if ($seen.RateLimited) { Write-DownloadFailure 'ratelimit' }
        return 'usable'
    }
    if ($seen.RateLimited) {
        Write-DownloadFailure 'ratelimit'
        return 'failed'
    }
    Write-Warn "wsl --update 失敗，從 GitHub 下載最新版 WSL..."
    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/microsoft/WSL/releases/latest" -TimeoutSec 30
        # 依這台電腦的架構選 MSI：ARM64 的 Windows 裝 x64 版不能用（#2650 第 7 項）。
        $arch = Get-WindowsArch
        $msiAsset = $release.assets | Where-Object { $_.name -match "\.$arch\.msi$" } | Select-Object -First 1
        if (-not $msiAsset) {
            Write-Err "找不到 $arch 的 MSI 下載連結"
            Write-Info "請手動到 https://github.com/microsoft/WSL/releases 下載 $arch 的 .msi 安裝"
            return 'failed'
        }
        $wslMsi = "$env:TEMP\wsl-latest.msi"
        Write-Info "  下載中: $($msiAsset.name) ($($release.tag_name))..."
        Invoke-InstallDownload -Uri $msiAsset.browser_download_url -OutFile $wslMsi -TimeoutSec 1800
        $msiCode = Invoke-Watched -Label "安裝 WSL" -Usually "通常需要 1–2 分鐘" -UpperMinutes 5 -TimeoutSeconds 1800 -NoProgressSeconds 0 -Encoding oem -File "msiexec.exe" -Arguments @("/i", $wslMsi, "/quiet", "/norestart")
        Remove-Item $wslMsi -Force -ErrorAction SilentlyContinue
        if ($msiCode -eq 3010) { return 'reboot' }
        if ($msiCode -ne 0) {
            Write-Err "MSI 安裝失敗 (exit code: $msiCode)"
            Write-Info "請手動到 https://github.com/microsoft/WSL/releases 下載 .msi 安裝"
            return 'failed'
        }
        Write-Ok "WSL $($release.tag_name) 已從 GitHub 安裝"
    } catch {
        Write-Err "從 GitHub 下載 WSL 失敗。"
        Write-DownloadFailure (Get-DownloadFailureKind $_)
        return 'failed'
    }
    $versionProbe = Invoke-BoundedWsl -Arguments @('--version')
    if ($versionProbe.Code -ne 0) { return 'verify-reboot' }
    return 'updated'
}

# ── 在瀏覽器裡設定（#1853：取代主控台裡的 agend quickstart）─────────────
# agend setup 在 WSL 裡開一個設定頁，印出網址和設定碼。安裝程式讀到這兩行，就在 Windows 的瀏覽器打開網址、
# 把設定碼放進剪貼簿並放大顯示；使用者在網頁上選 Discord 或 Telegram、貼上 Bot Token，不必在這個視窗打字。
# WSL 2 預設會把 localhost 轉給 Windows，所以 Windows 的瀏覽器開得了 127.0.0.1 的網址。
function Get-SetupPrompt([string]$line) {
    if ($line -match 'Setup page:\s*(https?://\S+)') { return @{ Url = $Matches[1] } }
    if ($line -match 'Setup code:\s*([A-Z2-7]{4}-[A-Z2-7]{4})') { return @{ Code = $Matches[1] } }
    # #2650 第 1 項：設定頁要求主機確認時，agend setup 印出的稽核行（2026-10-09 起每一版都有，不必等新版）。只認設定頁自己
    # 提出的（source 是 setup_session）、編號是 32 位小寫十六進位的；其他一律不理。
    if ($line -match 'Settings confirmation requested:\s*(\{.*\})\s*$') {
        try { $f = $Matches[1] | ConvertFrom-Json -ErrorAction Stop } catch { return $null }
        if ($f.source -ceq 'setup_session' -and ([string]$f.id) -cmatch '^[0-9a-f]{32}\z') { return @{ Confirm = [string]$f.id } }
        return $null
    }
    # 設定頁為什麼關掉（agend setup 的 "Setup host stopped (原因)"）：ttl、idle、lockout 等，用來說清楚發生什麼事。
    if ($line -match 'Setup host stopped \(([a-z ]{1,40})\)') { return @{ Stopped = $Matches[1] } }
    return $null
}
function Open-InBrowser([string]$url) { try { Start-Process $url; return $true } catch { return $false } }
function Set-SetupClipboard([string]$text) { try { Set-Clipboard -Value $text; return $true } catch { return $false } }
# 另開一個視窗執行 agend settings confirm：那個視窗先列出這次設定會改什麼，再問 y/N（agend 自己問，不是安裝程式代答）。
# 這個視窗正在等設定頁，不能在這裡打字，所以確認放到另一個視窗。回傳視窗有沒有打開。
function Open-HostConfirmWindow([string]$id) {
    if ($id -cnotmatch '^[0-9a-f]{32}\z') { return $false }
    $script = 'printf ''\033]0;AgEnD setup confirmation\007''; ' + (Get-WslAgendCommand ('agend settings confirm ' + $id)) + '; echo; read -r -p ''Press Enter to close this window. '' _'
    try {
        $null = Start-Process -FilePath 'wsl.exe' -ArgumentList (Join-ProcessArguments @('-d', $UBUNTU_DISTRO, '-u', $AGEND_USER, '--exec', 'bash', '-lc', $script))
        return $true
    } catch { return $false }
}
function Show-HostConfirm([string]$id, [bool]$opened) {
    Write-Host ""
    Write-Warn "設定頁要你在這台電腦上確認設定（網頁自己不能確認，要有人在這台電腦上同意）。"
    if ($opened) {
        Write-Ok "已經另外打開一個「AgEnD setup confirmation」視窗：看過裡面列出的內容，沒問題就輸入 y 再按 Enter。"
        Write-Info "確認後回到網頁，按「Start AgEnD」。"
    } else {
        Write-Warn "沒辦法自動打開確認視窗。"
    }
    Write-Info "沒看到確認視窗的話：另外開一個 PowerShell 視窗，貼上這一行再按 Enter（同樣會先列出內容、問你 y/N）："
    Write-Host ("    " + (Get-HostConfirmCommand $id)) -ForegroundColor Cyan
    Write-Host ""
}
# 一行字照視窗寬度自己換行（中日韓文字佔兩格），續行縮排對齊；不讓主控台把尾巴折到第 0 欄（使用者實測：約 95 欄的視窗）。
function Split-DisplayLines([string]$text, [int]$width) {
    $lines = @(); $cur = ''; $curW = 0
    foreach ($ch in $text.ToCharArray()) {
        $cw = Get-DisplayWidth ([string]$ch)
        if ($curW + $cw -gt $width -and $cur) { $lines += $cur; $cur = ''; $curW = 0 }
        $cur += $ch; $curW += $cw
    }
    if ($cur -or -not $lines.Count) { $lines += $cur }
    return ,$lines
}
function Write-Wrapped([string]$prefix, [string]$text, [string]$color = 'White') {
    $w = Get-StatusWidth
    $indent = ' ' * (Get-DisplayWidth $prefix)
    $parts = Split-DisplayLines $text ([Math]::Max(10, $w - (Get-DisplayWidth $prefix)))
    for ($i = 0; $i -lt $parts.Count; $i++) { Write-Host ($(if ($i -eq 0) { $prefix } else { $indent }) + $parts[$i]) -ForegroundColor $color }
    Write-InstallLog ($prefix + $text)
}
function Show-SetupCode([string]$code, [bool]$copied, [bool]$opened, [string]$url) {
    $spaced = ($code.ToCharArray() | ForEach-Object { [string]$_ }) -join ' '
    $label = "設定碼：  " + $spaced
    $w = Get-StatusWidth
    # 框線只用 ASCII（┌─┐ 在中文字型的主控台會佔兩格，框就散掉）；放得下才畫，放不下就單獨一行印出設定碼。
    $inner = (Get-DisplayWidth $label) + 6
    Write-Host ""
    if ($inner + 4 -le $w) {
        $rule = "  +" + ('-' * $inner) + "+"
        Write-Host $rule -ForegroundColor Green
        Write-Host ("  |   " + $label + (' ' * ($inner - 3 - (Get-DisplayWidth $label))) + "|") -ForegroundColor Green
        Write-Host $rule -ForegroundColor Green
    } else {
        Write-Host ("  " + $label) -ForegroundColor Green
    }
    if ($copied) { Write-Wrapped "  " "（設定碼已複製到剪貼簿：在網頁的輸入框按 Ctrl+V 或右鍵貼上，不必自己打）" 'Green' }
    if ($opened) { Write-Ok "設定頁已在瀏覽器打開。" } else { Write-Warn "瀏覽器沒有自動打開，請自己打開下面的網址。" }
    # #2650 第 10 項：網址一定印出來。瀏覽器開到別的視窗、別的帳號，或分頁被關掉時，都可以複製它重新打開。
    Write-Host ("  設定頁網址：" + $url) -ForegroundColor White                   # Write-Host：不進安裝紀錄檔（網址含這次設定的路徑）
    if (-not $copied) { Write-Wrapped "  " "在網頁的輸入框輸入上面的設定碼。" }
    Write-Wrapped "  " "在網頁上選擇 Discord 或 Telegram 並貼上 Bot Token，或選「Web only (no bot)」只用網頁；最後按完成。這個視窗會等你，不用在這裡打字。"
    Write-Wrapped "  " "設定頁最多開 15 分鐘（10 分鐘沒有操作也會關閉）。關掉了也沒關係：回到這個視窗按 Enter 就會重新打開，已經完成的後端登入不用重來。"
    Write-Host ""
}
# 設定頁關掉的原因，說給人聽（agend setup 印的英文原因 → 中文）。不認得的原因只說「關閉了」。
function Get-SetupStopText([string]$reason) {
    switch ($reason) {
        'ttl' { return '設定頁開滿 15 分鐘，自動關閉了。' }
        'idle' { return '設定頁太久沒有操作，自動關閉了。' }
        'lockout' { return '設定碼輸錯太多次，設定頁關閉了。' }
    }
    return '設定頁關閉了，設定還沒完成。'
}
# 跑一次設定頁。$Run 收到一個每行呼叫的 hook，回傳結束碼。結果：Done（完成、AgEnD 已啟動）、Already（之前就設定好了）、
# Shown（設定頁有沒有出現過）、Stopped（設定頁關掉的原因，沒有就是 $null）。設定頁要求主機確認時，每個確認編號開一次
# 確認視窗（同一個設定頁最多 5 次），並印出可以自己貼的指令。
# 設定頁是 WSL 裡印出的網址：WSL 的 localhost 轉送要過一下子才接上新開的連接埠，太早打開，瀏覽器會顯示「連線已重設」
# （使用者實測）。打開之前先從 Windows 這邊試連，得到任何 HTTP 回應（包括 404）就算連得到；連不到最多等 $seconds 秒。
function Wait-SetupPageReachable([string]$url, [int]$seconds = 20) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $seconds) {
        try { $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0 -ErrorAction Stop; return $true }
        catch { if ($_.Exception.Response) { return $true } }
        Start-Sleep -Milliseconds 500
    }
    return $false
}
function Invoke-BrowserSetup([scriptblock]$Run) {
    $setupSeen = @{ Url = $null; Code = $null; Shown = $false; Done = $false; Already = $false; Stopped = $null; Confirms = @() }
    $hook = {
        param([string]$line)
        $prompt = Get-SetupPrompt $line
        if ($prompt -and $prompt.Url) { $setupSeen.Url = $prompt.Url }
        if ($prompt -and $prompt.Code) { $setupSeen.Code = $prompt.Code }
        if ($prompt -and $prompt.Stopped) { $setupSeen.Stopped = $prompt.Stopped }
        if ($prompt -and $prompt.Confirm -and $setupSeen.Confirms -notcontains $prompt.Confirm -and $setupSeen.Confirms.Count -lt 5) {
            $setupSeen.Confirms += $prompt.Confirm
            Show-HostConfirm $prompt.Confirm (Open-HostConfirmWindow $prompt.Confirm)
        }
        if ($line -match 'Setup complete') { $setupSeen.Done = $true }
        if ($line -match 'Setup has already been completed') { $setupSeen.Already = $true }
        if ($setupSeen.Url -and $setupSeen.Code -and -not $setupSeen.Shown) {
            $setupSeen.Shown = $true
            $copied = Set-SetupClipboard $setupSeen.Code
            if (-not (Wait-SetupPageReachable $setupSeen.Url)) {
                Write-Warn "從 Windows 還連不到設定頁。仍會打開它；若顯示「連線已重設」，等幾秒再重新整理。一直如此時，可能是另一個 Linux 佔著這個連接埠：在 PowerShell 執行 netstat -ano 查看那個連接埠。"
            }
            $opened = Open-InBrowser $setupSeen.Url
            Show-SetupCode $setupSeen.Code $copied $opened $setupSeen.Url
            $script:WatchQuiet = $true
        }
    }
    try { $exit = & $Run $hook } finally { $script:WatchQuiet = $false }
    return @{ Exit = $exit; Done = $setupSeen.Done; Already = $setupSeen.Already; Shown = $setupSeen.Shown; Stopped = $setupSeen.Stopped }
}

# 第 5 階段的設定與服務（#2235 審查：每一步都要命令成功才算完成）。回傳 $true 才可以標記完成；$false 表示使用者選擇結束，
# 進度保留，下次執行同一行指令會從這一步繼續。
$AGEND_ENV = 'export PATH=/root/.local/bin:$PATH; source /root/.nvm/nvm.sh 2>/dev/null; umask 077; node --input-type=commonjs -e ''`use strict`;  var fs = require(`fs`); var path = require(`path`);  function checkedPath(dir, io, missingAllowed, message) {   var absolute = path.resolve(dir), parent = path.parse(absolute).root;   var pieces = absolute.slice(parent.length).split(path.sep).filter(Boolean), info;   for (var i = 0; i < pieces.length; i++) {     parent = path.join(parent, pieces[i]);     try { info = io.lstatSync(parent); }     catch (error) { if (missingAllowed && error.code === `ENOENT`) return null; throw error; }     if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(message);   }   return info || io.lstatSync(absolute); }  /** Create privately; repair only an owned real home, never chmod by pathname or through a symlink. */ function ensurePrivateHome(dir, options) {   var opts = options || {}, io = opts.fs || fs;   var uid = opts.uid === undefined ? (typeof process.getuid === `function` ? process.getuid() : null) : opts.uid;   var label = opts.label || `AgEnD`;   var message = label + ` requires an owned real AGEND_HOME without group/other write permission.`;   checkedPath(dir, io, opts.create !== false, message);   if (opts.create !== false) io.mkdirSync(dir, { recursive: true, mode: 448 });    var before = checkedPath(dir, io, false, message);      if (uid === null) return;   if (before.uid !== uid) throw new Error(message);   var fd = io.openSync(dir, io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW);   try {     if (opts.afterOpen) opts.afterOpen();      var info = io.fstatSync(fd), current = checkedPath(dir, io, false, message);     if (!info.isDirectory() || info.uid !== uid || current.dev !== info.dev || current.ino !== info.ino) throw new Error(message);     if (info.mode & 63) {        io.fchmodSync(fd, 448);       if ((io.fstatSync(fd).mode & 511) !== 448) throw new Error(message);       (opts.log || function (line) { console.warn(line); })(`AgEnD: tightened owned AGEND_HOME permissions to 0700.`);     }   } finally { io.closeSync(fd); } }  module.exports = { ensurePrivateHome: ensurePrivateHome }; ensurePrivateHome(process.env.AGEND_HOME || path.join(require(`os`).homedir(), `.agend`));'' || exit $?; '
# 主控台版的 quickstart：子程序直接接在這個視窗上（它的提示和你的輸入都在這裡），函式只回傳它的結束碼。不能直接在
# 函式裡執行 wsl：原生程式的輸出會進到函式的回傳值，提示就看不到，結束碼也會變成一個陣列（#2235 審查）。
function Invoke-ConsoleQuickstart {
    Write-Warn "要貼上 Bot Token：在視窗裡按一下右鍵。"
    Write-Warn "設定時請不要按 Ctrl+C：它會直接結束設定。"
    try {
        $p = Start-Process -FilePath 'wsl.exe' -NoNewWindow -Wait -PassThru `
            -ArgumentList (Join-ProcessArguments @('-d', $UBUNTU_DISTRO, '-u', $AGEND_USER, '--exec', 'bash', '-lc', ($AGEND_ENV + 'agend quickstart')))
        if ($null -eq $p.ExitCode) { return 1 }
        return [int]$p.ExitCode
    } catch { return 1 }
}
function Test-BrowserSignInCapability([string]$distro, [string]$user) {
    $result = Invoke-AgendInWsl $distro $user 'agend setup --backend-signin-capabilities'
    if ($result.Code -ne 0 -or $result.Text.Length -gt 4096) { return $false }
    try {
        $c = $result.Text | ConvertFrom-Json -ErrorAction Stop
        return (($c.version -is [int] -or $c.version -is [long]) -and $c.version -eq 1 -and $c.setup -is [bool] -and $c.setup -and
            $c.dashboard -is [bool] -and $c.dashboard -and $c.installer -is [bool] -and $c.installer -and
            @($c.backends) -contains 'kiro-cli' -and @($c.backends) -contains 'claude-code' -and @($c.backends) -contains 'codex')
    } catch { return $false }
}
function Get-BrowserSignInSelection($backends) {
    $ids = @{ kiro = 'kiro-cli'; claude = 'claude-code'; codex = 'codex'; antigravity = 'antigravity' }
    $pending = @()
    foreach ($b in @($backends)) {
        if (-not $ids.ContainsKey([string]$b.Key)) { throw 'Unknown backend selection' }
        if (-not (Test-WslLogin $b.Key)) { $pending += $ids[[string]$b.Key] }
    }
    return (($pending | Select-Object -Unique) -join ',')
}
function Get-BrowserSetupCommand([string]$BackendSignins = '') {
    if (-not $BackendSignins) { return 'agend setup' }
    if ($BackendSignins -cnotmatch '^(kiro-cli|claude-code|codex|antigravity)(,(kiro-cli|claude-code|codex|antigravity)){0,3}\z') { throw 'Invalid backend selection' }
    return ('agend setup --backend-signins ' + $BackendSignins)
}
# ── AgEnD 的連接埠：先找一組 Windows 和 Linux 都能用的（使用者實測，2026-10-26）──
# AgEnD 用兩個相鄰的連接埠：health_port（儀表板、/health，也是設定頁）和 health_port+1（web 預覽，預設值）。
# 另一個 Linux（例如之前裝過 AgEnD 的那個）的 WSL localhost 轉送（wslrelay.exe）可能還佔著 Windows 的 127.0.0.1:19280：
# 瀏覽器連到的是那個 Linux，那裡沒有東西在聽，就顯示「連線已重設」。所以設定開始前，從 19280 起一組一組試（P 和 P+1）：
# Windows 沒有程式在聽、不在 Windows 保留的範圍、Linux（所有發行版共用一個網路）裡也沒有程式在聽，就用它，寫進
# fleet.yaml 的 health_port（設定頁和之後的 fleet 都照它；2.3.1 起都支援），也記進進度檔。已經設定好的 fleet.yaml 不改。
$AGEND_PORT_FIRST = 19280
$AGEND_PORT_TRIES = 20
function Get-WindowsPortListener([int]$port) {
    try { $c = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop) | Select-Object -First 1 } catch { return $null }
    if (-not $c) { return $null }
    $name = ''; try { $name = [string](Get-Process -Id $c.OwningProcess -ErrorAction Stop).ProcessName } catch { }
    return @{ Pid = [int]$c.OwningProcess; Name = $name }
}
# Windows 的連接埠轉送規則（netsh interface portproxy，由 svchost 的 iphlpsvc 監聽）：常見的是以前為 WSL 設的、指向已經不在的
# WSL IP 的規則，連過去就是「連線已重設」（使用者實測）。只讀，絕不自動刪除。回傳 @{ ListenAddress; Target } 或 $null。
function Get-PortProxyRule([int]$port) {
    $text = ''
    try { $text = (& netsh.exe interface portproxy show v4tov4 2>$null) -join "`n" } catch { return $null }
    foreach ($m in [regex]::Matches($text, '(?m)^\s*(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$')) {
        if ([int]$m.Groups[2].Value -eq $port) { return @{ ListenAddress = $m.Groups[1].Value; Target = ($m.Groups[3].Value + ':' + $m.Groups[4].Value) } }
    }
    return $null
}
# Windows 保留給 Hyper-V/WinNAT 等的連接埠範圍（netsh 讀不到就當作沒有）。
function Get-ExcludedPortRanges {
    $text = ''
    try { $text = (& netsh.exe int ipv4 show excludedportrange protocol=tcp 2>$null) -join "`n" } catch { return @() }
    return @([regex]::Matches($text, '(?m)^\s*(\d+)\s+(\d+)') | ForEach-Object { @{ Start = [int]$_.Groups[1].Value; End = [int]$_.Groups[2].Value } })
}
function Test-PortExcluded([int]$port, $ranges) {
    foreach ($r in @($ranges)) { if ($port -ge $r.Start -and $port -le $r.End) { return $true } }
    return $false
}
# Linux 裡有沒有程式在聽（連得上就是有）。讀不到時當作不能用。
function Test-WslPortFree([int]$port) {
    $r = Invoke-BoundedWsl -Arguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--exec', 'bash', '-c', ('if (exec 3<>/dev/tcp/127.0.0.1/' + $port + ') 2>/dev/null; then echo PORT_BUSY; else echo PORT_FREE; fi'))
    return ($r.Code -eq 0 -and $r.Text -match 'PORT_FREE')
}
# 這個 Linux 裡的 fleet.yaml：沒有（None）、只有安裝程式寫的 health_port 一行（Seeded），或已經設定好的（Configured，連同它的 health_port）。
function Get-AgendPortConfig {
    $script = 'f=${AGEND_HOME:-$HOME/.agend}/fleet.yaml; [ -f "$f" ] || { echo CFG_NONE; exit 0; }; p=$(sed -n "s/^health_port:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p" "$f" | head -n 1); if [ "$(grep -cv "^[[:space:]]*$" "$f")" = 1 ] && [ -n "$p" ]; then echo "CFG_SEEDED=$p"; else echo "CFG_CONFIGURED=${p:-19280}"; fi'
    $r = Invoke-BoundedWsl -Arguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--exec', 'bash', '-c', $script)
    if ($r.Code -ne 0) { return $null }
    if ($r.Text -match 'CFG_NONE') { return @{ State = 'none'; Port = $null } }
    if ($r.Text -match 'CFG_SEEDED=(\d+)') { return @{ State = 'seeded'; Port = [int]$Matches[1] } }
    if ($r.Text -match 'CFG_CONFIGURED=(\d+)') { return @{ State = 'configured'; Port = [int]$Matches[1] } }
    return $null
}
function Select-AgendPorts {
    $cfg = Get-AgendPortConfig
    if ($null -eq $cfg) { Write-Err "讀不到這個 Linux 裡的 AgEnD 設定，先停在這裡。"; return $null }
    if ($cfg.State -eq 'configured') { return $cfg.Port }   # 已經設定好的 fleet 不改它的連接埠
    $ranges = Get-ExcludedPortRanges
    $saved = Get-ProgressValue 'AGEND_PORT' '\d+'
    $candidates = @()
    if ($cfg.State -eq 'seeded') { $candidates += $cfg.Port }
    if ($saved) { $candidates += [int]$saved }
    for ($i = 0; $i -lt $AGEND_PORT_TRIES; $i++) { $candidates += ($AGEND_PORT_FIRST + 2 * $i) }
    foreach ($p in @($candidates | Select-Object -Unique)) {
        if ($p -lt 1024 -or $p -gt 65534) { continue }
        $why = $null
        foreach ($q in @($p, ($p + 1))) {
            if (Test-PortExcluded $q $ranges) { $why = "Windows 保留了 $q"; break }
            $h = Get-WindowsPortListener $q
            if ($h) {
                $rule = if ($h.Name -eq 'svchost') { Get-PortProxyRule $q } else { $null }
                if ($rule) {
                    $why = ("Windows 的連接埠轉送規則（portproxy）把 {0} 轉到 {1}" -f $q, $rule.Target)
                    Write-Info ("  若那條規則已經沒用，可以用系統管理員 PowerShell 刪除：netsh interface portproxy delete v4tov4 listenport={0} listenaddress={1}" -f $q, $rule.ListenAddress)
                } else { $why = ("Windows 上的 {0} 被「{1}」佔用" -f $q, $h.Name) }
                break
            }
            if (-not (Test-WslPortFree $q)) { $why = "Linux 裡的 $q 已有程式在用"; break }
        }
        if ($why) { Write-Info ("  連接埠 {0}/{1} 不能用（{2}），試下一組..." -f $p, ($p + 1), $why); continue }
        # 只寫安裝程式自己的那一行，絕不蓋掉別的設定（#2723 審查）。沒有檔案：用 noclobber 建立。有我們上次寫的那一行：先把
        # 檔案原子地改名移開（rename），確認移開的就是那一行，再用 noclobber 建立新的——檢查之後才出現的設定，要嘛還在原位
        # （我們的建立失敗），要嘛就是被移開的那一份（用 ln 放回原位，ln 不會覆蓋；放不回去就留在旁邊的目錄裡並說出位置）。
        # 別人的內容一律不刪。
        $prior = if ($cfg.State -eq 'seeded') { [string]$cfg.Port } else { '' }
        $write = 'umask 077; d=${AGEND_HOME:-$HOME/.agend}; f="$d/fleet.yaml"; mkdir -p "$d" || exit 1; ' +
            ('if [ -z "' + $prior + '" ]; then set -C; printf ''health_port: %s\n'' ' + $p + ' > "$f" 2>/dev/null || exit 9; exit 0; fi; ') +
            # 移開的那一份放進新建、只屬於這一次的目錄（mktemp -d）：目的地一定還不存在，舊的備份不會被蓋掉（#2723 審查）。
            'k=$(mktemp -d "$d/.fleet-seed.XXXXXX") || exit 1; a="$k/fleet.yaml"; mv "$f" "$a" 2>/dev/null || { rmdir "$k"; exit 9; }; ' +
            ('if [ "$(cat "$a")" != "health_port: ' + $prior + '" ]; then if ln "$a" "$f" 2>/dev/null; then rm -f "$a"; rmdir "$k"; else echo "KEPT_ASIDE=$a"; fi; exit 9; fi; ') +
            ('if ( set -C; printf ''health_port: %s\n'' ' + $p + ' > "$f" ) 2>/dev/null; then rm -f "$a"; rmdir "$k"; exit 0; fi; ') +
            'rm -f "$a"; rmdir "$k"; exit 9'
        $seed = Invoke-BoundedWsl -Arguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--exec', 'bash', '-c', $write)
        if ($seed.Code -eq 9) {
            if ($seed.Text -match 'KEPT_ASIDE=(\S+)') { Write-Warn ("AgEnD 的設定檔在檢查之後被別的程式改寫了；那一份原封不動保存在 {0}。" -f $Matches[1]) }
            $now = Get-AgendPortConfig
            if ($now -and $now.State -eq 'configured') { Write-Info ("AgEnD 的設定檔剛剛已經建立，沿用它的連接埠 {0}" -f $now.Port); return $now.Port }
            Write-Err "AgEnD 的設定檔在檢查之後被改動了，為了不蓋掉它，先停在這裡。請再執行同一行安裝指令。"; return $null
        }
        if ($seed.Code -ne 0) { Write-Err "寫不進 AgEnD 的設定檔，先停在這裡。"; return $null }
        Add-Content -LiteralPath $ProgressFile -Value ('AGEND_PORT=' + $p)
        if ($p -ne $AGEND_PORT_FIRST) { Write-Ok ("AgEnD 的儀表板改用連接埠 {0}（預覽 {1}）" -f $p, ($p + 1)) }
        return $p
    }
    Write-Err ("從 {0} 起找不到兩個相鄰都能用的連接埠。" -f $AGEND_PORT_FIRST)
    Write-Info "可以在 PowerShell 執行 netstat -ano | findstr :19280 看是誰佔著，關掉它之後再執行同一行安裝指令。"
    return $null
}
function Invoke-SetupAndService([string]$BackendSignins = '', $Backends = $null) {
    $configured = $false
    while (-not $configured) {
        $setupCommand = Get-BrowserSetupCommand $BackendSignins
        $setup = Invoke-BrowserSetup { param($hook) Invoke-WslStep -Label "等待你在瀏覽器完成設定" -Usually "設定頁 15 分鐘沒完成會自動關閉" -UpperMinutes 15 -OnLine $hook -Script ($AGEND_ENV + $setupCommand) }
        if ($setup.Done -or $setup.Already) { $configured = $true; break }
        Write-Host ""
        if ($setup.Shown) {
            # #2650 第 10 項：說清楚為什麼關掉、什麼還在，並給三條路：重新打開、改在這個視窗設定、結束（進度保留）。
            Write-Warn (Get-SetupStopText $setup.Stopped)
            $again = Read-Host "  按 Enter 重新打開設定頁；輸入 c 改在這個視窗設定；輸入 n 結束（下次執行同一行指令會從這一步繼續）"
            if ($again -match '^\s*[nN]') { return $false }
            if ($again -match '^\s*[cC]') {
                $qs = Invoke-ConsoleQuickstart
                if ($qs -eq 0) { $configured = $true } else { Write-Warn "主控台的設定沒有完成（結束碼 $qs）。" }
                continue
            }
            # 重新打開前再查一次哪些後端已經登入：已經登入的不用在新的設定頁再登一次（不會重複一個做到一半的登入）。
            if ($BackendSignins -and $Backends) {
                $BackendSignins = Get-BrowserSignInSelection $Backends
                if (-not $BackendSignins) { Write-Ok "選的後端都已經登入，新的設定頁不會再要求登入。" }
            }
        } else {
            Write-Warn "設定頁沒有出現。"
            $console = Read-Host "  改在這個視窗設定嗎？(Y/n)"
            if ($console -match '^\s*[nN]') { return $false }
            $qs = Invoke-ConsoleQuickstart
            if ($qs -eq 0) { $configured = $true } else { Write-Warn "主控台的設定沒有完成（結束碼 $qs）。" }
        }
    }
    # 設定頁完成時，AgEnD 是以一般程序啟動的：改成系統服務（開機自動啟動），agend install 會先停掉手動啟動的那一個。
    # 服務已經在跑（主控台設定時已安裝，或上次中斷前已裝好）就不再裝：agend install 會停掉它，而正常結束的服務不會被重新拉起。
    while ($true) {
        $code = Invoke-WslStep -Label "安裝並啟動 AgEnD 服務" -Usually "通常不到 1 分鐘" -UpperMinutes 3 -Script ($AGEND_ENV + 'if systemctl --user is-active --quiet com.agend.fleet; then echo "AgEnD service is already running"; else agend install; fi')
        if ($code -eq 0) { return $true }
        Write-Err "AgEnD 服務沒有安裝成功（結束碼 $code）。設定已經存好，不用重新設定。"
        Set-InstallFailure 'service'
        $again = Read-Host "  按 Enter 再試一次；輸入 n 再按 Enter 結束"
        if ($again -match '^\s*[nN]') { return $false }
    }
}

# ── AI 後端定義（可多選安裝）─────────────────────────────
# Note/Install 用單引號避免 PowerShell 內插（$ 為字面）
$ALL_BACKENDS = @(
    [PSCustomObject]@{ Id=1; Key="kiro";        Name="Kiro CLI";        Note='免費，需 AWS Builder ID / GitHub / Google'; Install='curl -fsSL https://cli.kiro.dev/install | bash';                 Bin="kiro-cli"; NeedsNode=$false },
    [PSCustomObject]@{ Id=2; Key="claude";      Name="Claude Code";     Note='需 Anthropic 帳號，Claude Pro $20/月+';       Install='curl -fsSL https://claude.ai/install.sh | bash';                  Bin="claude";   NeedsNode=$false },
    [PSCustomObject]@{ Id=3; Key="antigravity"; Name="Antigravity CLI"; Note='免費，需 Google 帳號';                        Install='curl -fsSL https://antigravity.google/cli/install.sh | bash';     Bin="agy";      NeedsNode=$false },
    [PSCustomObject]@{ Id=4; Key="codex";       Name="OpenAI Codex";    Note='需 ChatGPT 帳號或 API Key';                   Install='curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'; Bin="codex";    NeedsNode=$false }
)
# 統一 PATH：涵蓋所有後端二進位位置（.local/bin: kiro/codex-global 等；.claude/local: Claude Code）
# 不加雙引號 —— 路徑無空白，且避免 PowerShell 5.1 傳參給 wsl 時的引號轉義問題
$BACKEND_PATH = 'export PATH=/root/.local/bin:$HOME/.claude/local:$PATH'
# 每個後端的安裝指令都在沒有控制終端機的情況下執行（stdin 是 /dev/null）：Invoke-Watched 透過 wsl.exe 執行時有 /dev/tty，
# 上游安裝程式若在 /dev/tty 上詢問（例如 Codex 的 "Start Codex now? [y/N]"），會一直等下去。
# setsid 讓它沒有 /dev/tty 可讀，問題便直接以預設值略過。__AGEND_INSTALL__ 會換成該後端的指令。
$UNATTENDED_INSTALL = @'
agend_install() {
set -e -o pipefail
__AGEND_INSTALL__
}
# Invoke-WslStep already gives this job a private session/process group and empty stdin.
agend_install </dev/null
'@

function Save-Backends($csv) { Add-Content -Path $ProgressFile -Value "BACKENDS=$csv" }

# 重跑安裝程式時，已經裝好且能執行的後端直接保留，不再跑它的安裝程式（#2583 後續）：Kiro 的 install.sh 在 kiro-cli
# 已存在時會在 /dev/tty 上問「Do you want to replace it?」，沒有參數能略過，沒有終端機時就以失敗結束；手動裝好的 Codex
# 以前也會被重裝。各 CLI 會自己更新（Claude、Antigravity 在背景更新；Codex、Kiro 有自己的 update 指令）。
# 找的位置就是各家安裝程式放的地方：PATH、/root/.local/bin、$HOME/.local/bin、$HOME/.claude/local，以及 npm 全域
# （例如 nvm 底下 npm i -g 裝的 codex）。只在 npm 全域找到時，連結到 $HOME/.local/bin，fleet 才找得到（AgEnD 以
# $AGEND_USER＝root 執行，跟這裡同一個使用者）。__BIN__ 會換成該後端的指令名稱。跟 $AGEND_PROBE 一樣寫成一行、
# 不含雙引號（IFS= 與 set -f 取代引號），這樣 5.1 把它當參數傳給 wsl.exe 時不會壞。
$BACKEND_PROBE = 'set -f; IFS=; export PATH=/root/.local/bin:$HOME/.local/bin:$HOME/.claude/local:$PATH; p=$(command -v __BIN__ 2>/dev/null) || p=; l=; if [ x$p = x ]; then [ -s $HOME/.nvm/nvm.sh ] && . $HOME/.nvm/nvm.sh >/dev/null 2>&1; n=$(npm prefix -g 2>/dev/null) || n=; if [ x$n != x ] && [ -x $n/bin/__BIN__ ]; then mkdir -p $HOME/.local/bin && ln -sf $n/bin/__BIN__ $HOME/.local/bin/__BIN__ && p=$HOME/.local/bin/__BIN__ && l=$n/bin/__BIN__; fi; fi; [ x$p != x ] || exit 1; v=$($p --version 2>/dev/null </dev/null) || exit 1; v=$(head -n 1 <<<$v); [ x$v != x ] || exit 1; echo KEPT\|$v\|$p\|$l'
# 回傳 @{ Version; Path; LinkedFrom }（已裝好且能執行），否則 $null。
function Get-InstalledBackend($b) {
    # --exec: `--` hands the line to the distro's shell, which expands $p, $(…) and $HOME in the probe before bash -c runs
    # it, so every backend read as missing (live: Codex installed, exit 0, then "尚未安裝成功"). --exec keeps the argv.
    $r = Invoke-BoundedWsl -Arguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--exec', 'bash', '-c', $BACKEND_PROBE.Replace('__BIN__', $b.Bin))
    if ($r.Code -ne 0) { return $null }
    $out = $r.Text
    $m = [regex]::Match($out, '(?m)^KEPT\|([^|\r\n]+)\|([^|\r\n]+)\|([^|\r\n]*)\r?$')
    if (-not $m.Success) { return $null }
    return @{ Version = $m.Groups[1].Value.Trim(); Path = $m.Groups[2].Value; LinkedFrom = $m.Groups[3].Value }
}
function Get-SavedBackends {
    if (Test-Path $ProgressFile) {
        $saved = Get-ProgressValue 'BACKENDS' '[\d,]+'
        if ($saved) { return $saved }
    }
    return "1"  # 向後相容：預設 Kiro CLI
}
# 接續安裝時的後端：列出上次選的，按 Enter 沿用，或輸入新的清單（一直失敗的後端不會把安裝卡住）。沒有互動式主控台時
# （無人值守）沿用上次的選擇，不問。
function Select-ResumeBackends([string]$saved) {
    $selected = @(Resolve-Backends $saved)
    Write-Info ("上次選擇的後端：" + (($selected | ForEach-Object { $_.Name }) -join "、"))
    if (Test-LiveConsole) {
        foreach ($b in $ALL_BACKENDS) { Write-Info ("  {0}. {1}（{2}）" -f $b.Id, $b.Name, $b.Note) }
        while ($true) {
            $sel = Read-Host "  直接按 Enter 沿用上次的選擇，或輸入新的數字（例：1,2）"
            if ([string]::IsNullOrWhiteSpace($sel)) { break }
            $picked = @(Resolve-Backends $sel)
            if ($picked.Count -gt 0) { $selected = $picked; break }
            Write-Warn "沒有可用的編號，請重新輸入，或直接按 Enter 沿用上次的選擇。"
        }
    }
    Write-Info "已能執行的保留，只重試缺少或損壞的後端。"
    return ,$selected
}
function Resolve-Backends($csv) {
    $ids = @($csv -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
    return @($ALL_BACKENDS | Where-Object { $ids -contains $_.Id })
}

function Check-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ── 長時間步驟：即時進度與主控台防護（#1853 使用者實測回饋）────────
# 長步驟在背景執行，它自己的輸出即時轉印出來，另有一行心跳顯示已經過的時間和「通常需要多久」，畫面不會一片安靜。
# 步驟進行中：關閉「快速編輯」（傳統主控台點一下視窗就會凍結正在跑的程式），並把 Ctrl+C 當成按鍵讀進來，
# 先問要不要停止，而不是直接中斷到一半。步驟結束（含停止）時，兩者都恢復原狀。
$script:OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)

# 主控台輸入模式（Windows）：ENABLE_PROCESSED_INPUT 0x1（Ctrl+C 是「停止」訊號）、ENABLE_QUICK_EDIT_MODE 0x40、
# ENABLE_EXTENDED_FLAGS 0x80（要改快速編輯必須帶上）。[Console]::TreatControlCAsInput 改的也是這份模式裡的 0x1，
# 和快速編輯分開存、分開還原會互相蓋掉（#2228 審查），所以不用它：長步驟開始時存下整份模式一次，一次寫入
# 「快速編輯關、Ctrl+C 當按鍵」，結束時（含停止）把存下的那份原樣寫回。
function Get-InputMode {
    if (-not $script:OnWindows) { return $null }
    try {
        if (-not ('AgEnD.ConsoleMode' -as [type])) {
            Add-Type -Namespace AgEnD -Name ConsoleMode -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@
        }
        $mode = [uint32]0
        if ([AgEnD.ConsoleMode]::GetConsoleMode([AgEnD.ConsoleMode]::GetStdHandle(-10), [ref]$mode)) { return $mode }   # STD_INPUT_HANDLE
    } catch { }
    return $null
}
function Set-InputMode([uint32]$mode) {
    try { return [AgEnD.ConsoleMode]::SetConsoleMode([AgEnD.ConsoleMode]::GetStdHandle(-10), $mode) } catch { return $false }
}
# 回傳存下的模式；$null 表示這不是真主控台（或改不了），什麼都沒改。
function Enter-StepConsole {
    $saved = Get-InputMode
    if ($null -eq $saved) { return $null }
    $guarded = [long]$saved -bor 0x80
    if ($guarded -band 0x40) { $guarded -= 0x40 }                      # 快速編輯關
    if ($guarded -band 0x1) { $guarded -= 0x1 }                        # Ctrl+C 當按鍵讀
    if (-not (Set-InputMode ([uint32]$guarded))) { return $null }
    return $saved
}
function Restore-StepConsole($saved) {
    if ($null -eq $saved) { return }
    [void](Set-InputMode ([uint32]([long]$saved -bor 0x80)))           # 帶 0x80，原本的快速編輯設定才寫得回去
}
function Test-LiveConsole { try { return (-not [Console]::IsOutputRedirected -and -not [Console]::IsInputRedirected) } catch { return $false } }
function Read-StepKey { try { if ([Console]::KeyAvailable) { return [Console]::ReadKey($true) } } catch { }; return $null }
function Test-CtrlC($key) { return ($key.KeyChar -eq [char]3) -or ($key.Key -eq 'C' -and ($key.Modifiers -band [ConsoleModifiers]::Control)) }
# 讀一行回答。長步驟中 Ctrl+C 已是按鍵、系統不再處理行編輯，所以自己處理 Enter 和退格；輸入被導向時（測試）就讀一行。
function Read-Answer {
    try {
        $s = ''
        while ($true) {
            $k = [Console]::ReadKey($true)
            if ($k.Key -eq 'Enter') { Write-Host ''; return $s }
            if ($k.Key -eq 'Backspace') { if ($s.Length -gt 0) { $s = $s.Substring(0, $s.Length - 1); Write-Host "`b `b" -NoNewline }; continue }
            if ([char]::IsControl($k.KeyChar)) { continue }
            $s += $k.KeyChar; Write-Host $k.KeyChar -NoNewline
        }
    } catch { return [Console]::ReadLine() }
}

# 狀態列可用的寬度（視窗寬度不明或太窄時用 79）。
function Get-StatusWidth { $w = 0; try { $w = [Console]::WindowWidth - 1 } catch { }; if ($w -lt 20) { $w = 79 }; return $w }
# Start-Process 用空白把參數接起來：含空白或引號的參數要加引號。
function Join-ProcessArguments([string[]]$Arguments) { return @($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) }

function Format-Elapsed([double]$seconds) {
    $s = [int][math]::Floor($seconds)
    if ($s -lt 60) { return "$s 秒" }
    return ("{0} 分 {1:00} 秒" -f [math]::Floor($s / 60), ($s % 60))
}

# 終端機上的顯示寬度：中日韓文字佔兩格。
function Get-DisplayWidth([string]$text) {
    $w = 0
    foreach ($ch in $text.ToCharArray()) {
        $c = [int]$ch
        if (($c -ge 0x1100 -and $c -le 0x115F) -or ($c -ge 0x2E80 -and $c -le 0xA4CF) -or ($c -ge 0xAC00 -and $c -le 0xD7A3) -or
            ($c -ge 0xF900 -and $c -le 0xFAFF) -or ($c -ge 0xFE30 -and $c -le 0xFE4F) -or ($c -ge 0xFF00 -and $c -le 0xFF60) -or ($c -ge 0xFFE0 -and $c -le 0xFFE6)) { $w += 2 } else { $w += 1 }
    }
    return $w
}
function Limit-Width([string]$text, [int]$max) {
    if ($max -lt 8) { return '' }
    if ((Get-DisplayWidth $text) -le $max) { return $text }
    $out = ''
    foreach ($ch in $text.ToCharArray()) { if ((Get-DisplayWidth ($out + $ch + '...')) -gt $max) { break }; $out += $ch }
    return $out + '...'
}
# 原地更新的狀態列：寧可算寬，也不能換行。舊的藍色主控台用中文字型或字碼頁時，「–」「…」這類寬度不定的字也佔兩格；
# 狀態列只要多出一格就會折到下一行，之後每次的 `r 只回到折下去的那一行，畫面就變成每秒多一行（使用者回報的截圖）。
# 所以這裡把每個非 ASCII 字都當兩格，再留一格。
function Get-SafeWidth([string]$text) {
    $w = 0
    foreach ($ch in $text.ToCharArray()) { if ([int]$ch -lt 0x80) { $w += 1 } else { $w += 2 } }
    return $w
}
function Format-StatusLine([string]$text, [int]$width) {
    $max = $width - 1
    if ($max -lt 8) { return '' }
    $text = $text -replace "[\r\n\t]", ' '
    if ((Get-SafeWidth $text) -le $max) { return $text }
    $out = ''
    foreach ($ch in $text.ToCharArray()) { if ((Get-SafeWidth ($out + $ch + '...')) -gt $max) { break }; $out += $ch }
    return $out + '...'
}
# 狀態列寫到主控台：用 PowerShell 主控台自己的 Unicode 寫法（和 Write-Host 同一條路），不用 [Console]::Write——在
# Windows PowerShell 5.1 它會先轉成主控台字碼頁，中文會變亂碼。$row：狀態列開始的那一行；游標不在那一行（萬一還是折行了）
# 就回到那一行重畫，清掉它用過的行，不會一秒多一行。回傳這次開始的行。$console 只給測試換成假的主控台。
function New-StatusConsole {
    return @{ Top = { [Console]::CursorTop }; Height = { [Console]::BufferHeight }; Move = { [Console]::SetCursorPosition(0, $args[0]) }; Write = { $Host.UI.Write($args[0]) } }
}
function Write-StatusLine([string]$text, [int]$width, $row, $console = $null) {
    if (-not $console) { $console = New-StatusConsole }
    try {
        $top = & $console.Top
        if ($null -ne $row -and $top -ne $row -and $row -ge 0 -and $row -lt (& $console.Height)) {
            for ($r = $row; $r -le $top; $r++) { & $console.Move $r; & $console.Write (' ' * $width) }
            & $console.Move $row
        } else {
            & $console.Write ("`r" + (' ' * $width) + "`r")
        }
        $start = & $console.Top
    } catch { $start = $null; & $console.Write "`r" }
    & $console.Write (Format-StatusLine $text $width)
    return $start
}

# 讀取子程序寫到檔案的新輸出，用這一步已知的編碼（不從位元組猜：純中文的 UTF-16 開頭可以是合法的 ASCII，
# 「上」U+4E0A 也含 0x0A，#2228 審查）。'utf8'：WSL 裡的程式（Linux 的輸出原樣傳過來）；'utf16'：wsl.exe 自己的指令
# （--update、--install）——這一步會拿掉 WSL_UTF8，而沒有它時每一版 wsl.exe（系統內建、Store、MSI）自己的訊息都是
# UTF-16LE（WSL_UTF8=1 從 0.64.0 起才會改成 UTF-8，所以不必知道裝的是哪一版）；'oem'：Windows 主控台程式（dism），
# 用主控台的字碼頁。解碼器會接住切在兩次讀取之間的多位元組字元。
function New-OutputTail([string]$path, [string]$encoding = 'utf8') {
    $enc = switch ($encoding) {
        'utf16' { [Text.Encoding]::Unicode }
        'oem' { try { [Console]::OutputEncoding } catch { [Text.Encoding]::Default } }
        default { [Text.Encoding]::UTF8 }
    }
    return @{ Path = $path; Stream = $null; Decoder = $enc.GetDecoder() }
}
function Read-OutputTail($tail) {
    if (-not $tail.Stream) {
        try { $tail.Stream = [IO.File]::Open($tail.Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete') } catch { return '' }
    }
    $buf = New-Object byte[] 65536
    $text = ''
    while (($n = $tail.Stream.Read($buf, 0, $buf.Length)) -gt 0) {
        $chars = New-Object char[] ($n + 4)
        $c = $tail.Decoder.GetChars($buf, 0, $n, $chars, 0)
        $text += New-Object string ($chars, 0, $c)
    }
    return ($text -replace [char]0xFEFF, '')
}
# 工具輸出的一段文字 → 已完成的行、還沒換行的尾巴、目前的進度字樣。去掉色彩控制碼；一行裡的 \r 是工具原地更新的
# 進度，只留最後一段（Windows 上子程序直接寫檔，\r 原樣保留）。
function Get-LastSegment([string]$s) { return (@($s -split "`r" | Where-Object { $_.Trim() }) | Select-Object -Last 1) }
function Split-ToolOutput([string]$text) {
    $text = $text -replace "\x1b\[[0-9;?]*[ -/]*[@-~]", '' -replace "\x1b\][^\x07]*\x07", ''
    $parts = $text -split "`n"
    $lines = @()
    for ($j = 0; $j -lt $parts.Count - 1; $j++) { $seg = Get-LastSegment $parts[$j]; if ($seg) { $lines += $seg.TrimEnd() } }
    $rest = $parts[-1]
    $now = Get-LastSegment $rest
    return @{ Lines = $lines; Rest = $rest; Progress = $(if ($now) { $now.Trim() } else { '' }) }
}

# 執行一個長步驟：背景跑 $File $Arguments，轉印它的輸出，顯示心跳。回傳它的結束碼。
#   $Usually：「通常需要 3–10 分鐘」；$UpperMinutes：超過就補一句「比平常久，仍在進行中」。
#   $HeartbeatSeconds：輸出被導向（不是真主控台）時，每隔幾秒印一行心跳（真主控台則每秒原地更新同一行）。
#   $Encoding：它輸出的編碼（見 New-OutputTail）。
#   $OnLine：每印出一行就呼叫一次（例如從 agend setup 的輸出讀出設定頁網址）。
function Stop-InstallChild($Process) {
    if ($Process.HasExited) { return }
    if (($PSVersionTable.PSEdition -eq 'Desktop') -or ($IsWindows -eq $true)) {
        $killer = Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID', $Process.Id, '/T', '/F') -NoNewWindow -PassThru
        if (-not $killer.WaitForExit(10000)) { try { $killer.Kill() } catch { } }
    } else { try { $Process.Kill() } catch { } }
    if (-not $Process.WaitForExit(10000)) { throw 'Installer-owned child did not close; do not start another install until it exits.' }
}

function Invoke-Watched {
    param([string]$Label, [string]$Usually, [string]$File, [string[]]$Arguments = @(), [double]$UpperMinutes = 0, [int]$HeartbeatSeconds = 30,
        [string]$Encoding = 'utf8', [scriptblock]$OnLine = $null, [double]$TimeoutSeconds = 1800, [double]$NoProgressSeconds = 300, [string]$CancellationFile = '')
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('agend-step-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $outFile = Join-Path $dir 'out.txt'; $errFile = Join-Path $dir 'err.txt'; $inFile = Join-Path $dir 'in.txt'
    [IO.File]::WriteAllText($inFile, '')
    $quoted = Join-ProcessArguments $Arguments
    $start = @{ FilePath = $File; NoNewWindow = $true; PassThru = $true; RedirectStandardOutput = $outFile; RedirectStandardError = $errFile }
    # 標準輸入接一個空檔：子程序不會跟這個視窗搶按鍵（Ctrl+C 留給上面的確認）。只在 Windows：那裡是把檔案交給子程序；
    # Linux 上的 pwsh 會自己把檔案寫進管線，子程序先結束就出錯（只有測試在 Linux 上跑）。
    if ($script:OnWindows) { $start.RedirectStandardInput = $inFile }
    if ($quoted.Count -gt 0) { $start.ArgumentList = $quoted }

    $live = Test-LiveConsole
    $consoleSaved = $null
    # wsl.exe 自己的訊息：'utf16' 的步驟拿掉 WSL_UTF8（每一版都是 UTF-16LE），其他步驟設成 1（UTF-8，和 Linux 的輸出一致）。
    # 這一步結束後（含停止）還原成原本的值或原本沒有。
    $prevUtf8 = $env:WSL_UTF8
    if ($Encoding -eq 'utf16') { Remove-Item Env:WSL_UTF8 -ErrorAction SilentlyContinue } else { $env:WSL_UTF8 = '1' }
    # 這一步的狀態（scriptblock 之間共用同一個 hashtable）。
    $st = @{ Tails = @((New-OutputTail $outFile $Encoding), (New-OutputTail $errFile $Encoding)); Pending = @('', ''); Progress = ''; Shown = $false; Row = $null; LastOutput = 0.0 }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $nextBeat = $HeartbeatSeconds
    $spin = '|/-\'
    $proc = $null

    $clearStatus = {
        if ($st.Shown) {
            $w = Get-StatusWidth
            try {
                $c = New-StatusConsole
                if ($null -ne $st.Row -and (& $c.Top) -ne $st.Row) { & $c.Move $st.Row }
                & $c.Write ("`r" + (' ' * $w) + "`r")
            } catch { }
            $st.Shown = $false; $st.Row = $null
        }
    }
    $beatText = {
        $t = "$Label：已經過 $(Format-Elapsed $clock.Elapsed.TotalSeconds)（$Usually）"
        if ($UpperMinutes -gt 0 -and $clock.Elapsed.TotalMinutes -gt $UpperMinutes) { $t += "，比平常久，仍在進行中，請不要關閉視窗" }
        return $t
    }
    $printLine = {
        param([string]$line)
        & $clearStatus; Write-Host ("    " + $line) -ForegroundColor DarkGray
        Write-InstallLog ("    " + $line)
        if ($OnLine) { & $OnLine $line }
    }
    $emit = {
        param([bool]$final)
        for ($k = 0; $k -lt 2; $k++) {
            $chunk = Read-OutputTail $st.Tails[$k]
            if ($chunk) {
                $st.LastOutput = $clock.Elapsed.TotalSeconds
                $cut = Split-ToolOutput ($st.Pending[$k] + $chunk)
                foreach ($line in $cut.Lines) { & $printLine $line }
                $st.Pending[$k] = $cut.Rest
                if ($cut.Progress) { $st.Progress = $cut.Progress }
            }
            if ($final) { $cut = Split-ToolOutput ($st.Pending[$k] + "`n"); foreach ($line in $cut.Lines) { & $printLine $line }; $st.Pending[$k] = '' }
        }
    }

    try {
        if ($live) { $consoleSaved = Enter-StepConsole }
        $proc = Start-Process @start
        $null = $proc.Handle                                              # 先取 Handle，之後才讀得到 ExitCode
        $tick = 0
        while (-not $proc.HasExited) {
            Start-Sleep -Milliseconds 250
            & $emit $false
            if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds -or ($NoProgressSeconds -gt 0 -and ($clock.Elapsed.TotalSeconds - $st.LastOutput) -ge $NoProgressSeconds)) {
                & $clearStatus
                Write-Err "$Label 超過等待上限或沒有新進度；正在停止這個安裝步驟。請檢查上方原因，再重新執行相同步驟。"
                if ($CancellationFile) {
                    [IO.File]::WriteAllText($CancellationFile, 'cancel')
                    $null = $proc.WaitForExit(5000)
                }
                Stop-InstallChild $proc
                return 124
            }
            if ($null -ne $consoleSaved) {
                while ($null -ne ($key = Read-StepKey)) {
                    if (Test-CtrlC $key) {
                        & $clearStatus
                        if (Confirm-StopInstall $proc $CancellationFile) {
                            Restore-StepConsole $consoleSaved; $consoleSaved = $null
                            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
                            exit 1
                        }
                    }
                }
            }
            if ($live -and $script:WatchQuiet) {
                # 設定頁開著、設定碼在畫面上：不再每 250 毫秒重畫一行（畫面會閃、選不到設定碼，使用者實測），只清掉一次。
                if ($st.Shown) { & $clearStatus }
            } elseif ($live) {
                $tick++
                $w = Get-StatusWidth
                $line = "  " + $spin[$tick % 4] + " " + (& $beatText)
                if ($st.Progress) { $line += "  " + $st.Progress }
                $st.Row = Write-StatusLine $line $w $(if ($st.Shown) { $st.Row } else { $null })
                $st.Shown = $true
            } elseif ($clock.Elapsed.TotalSeconds -ge $nextBeat) {
                Write-Host ("  ... " + (& $beatText))
                $nextBeat += $HeartbeatSeconds
            }
        }
        $proc.WaitForExit()
        & $emit $true
        & $clearStatus
        Write-Host ("  {0}：用了 {1}" -f $Label, (Format-Elapsed $clock.Elapsed.TotalSeconds)) -ForegroundColor DarkGray
        return $proc.ExitCode
    } finally {
        foreach ($t in $st.Tails) { if ($t.Stream) { $t.Stream.Dispose() } }
        Restore-StepConsole $consoleSaved
        if ($null -eq $prevUtf8) { Remove-Item Env:WSL_UTF8 -ErrorAction SilentlyContinue } else { $env:WSL_UTF8 = $prevUtf8 }
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 自動步驟中按了 Ctrl+C：先問，不直接中斷。回傳 $true 表示使用者要停止（子程序已結束）。
function Confirm-StopInstall($proc, [string]$CancellationFile = '') {
    Write-Host ""
    Write-Warn "你按了 Ctrl+C。在這個視窗裡，Ctrl+C 是「停止」，不是「複製」。"
    Write-Warn "安裝還在背景繼續進行，沒有中斷。"
    Write-Host "  要停止安裝嗎？輸入 y 再按 Enter 就停止；直接按 Enter 會繼續。" -ForegroundColor Yellow -NoNewline
    $answer = Read-Answer
    if (([string]$answer) -match '^\s*[yY]\s*$') {
        if ($CancellationFile) { [IO.File]::WriteAllText($CancellationFile, 'cancel'); $null = $proc.WaitForExit(5000) }
        if (-not $proc.HasExited) {
            if ($script:OnWindows) { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } else { try { $proc.Kill() } catch { } }
        }
        Write-Err "已停止安裝。"
        Write-Info "之後再執行同一行安裝指令（或此腳本），會從還沒完成的步驟繼續。"
        return $true
    }
    Write-Ok "繼續安裝..."
    return $false
}

# Failures must retain WSL's exit code and output in both the screen error and the redacted install log.
function Get-WslFailureMessage([string]$Operation, $Result) {
    $detail = Protect-LogText ([string]$Result.Text)
    $detail = ($detail -replace "`0", '').Trim()
    if (-not $detail) { $detail = '(no output)' }
    if ($detail.Length -gt 8192) { $detail = $detail.Substring(0, 8192) + ' [truncated]' }
    $message = "$Operation (exit $($Result.Code)): $detail"
    Write-InstallLog $message
    return $message
}
# `--` still runs a Linux shell: C:\ProgramData becomes C:ProgramData. --exec preserves the literal argv.
function ConvertTo-WslScriptPath([string]$File, [string]$Distro) {
    $r = Invoke-BoundedWsl -Arguments @('-d', $Distro, '-u', 'root', '--exec', 'wslpath', '-u', $File)
    if ($r.Code -ne 0) { throw (Get-WslFailureMessage 'WSL path conversion failed; no step was started' $r) }
    $path = $r.Text.Trim()
    if (-not $path.StartsWith('/') -or $path -match '[\r\n\x00]') {
        throw (Get-WslFailureMessage 'WSL path conversion returned an invalid path; no step was started' $r)
    }
    return $path
}
# LF, UTF-8 without BOM. Remove the unused file if conversion fails before any Linux step starts.
function New-WslScriptFile([string]$Script, [string]$Distro = $UBUNTU_DISTRO) {
    $dir = Join-Path $env:ProgramData 'AgEnD-install'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $file = Join-Path $dir ('step-' + [Guid]::NewGuid().ToString('N') + '.sh')
    try {
        [IO.File]::WriteAllText($file, ($Script -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
        $wslFile = ConvertTo-WslScriptPath $file $Distro
        return @($file, $wslFile)
    } catch {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        throw
    }
}
# 在 WSL 裡以 root 執行一段 bash 腳本，作為長步驟（見 Invoke-Watched）。
function Get-OwnedWslStepScript([string]$ScriptPath, [string]$CancellationPath, [int]$Seconds) {
    $script64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ScriptPath))
    $cancel64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($CancellationPath))
    return (@(
        'set -u'
        ('script=$(printf ''%s'' ''{0}'' | base64 -d)' -f $script64)
        ('cancel=$(printf ''%s'' ''{0}'' | base64 -d)' -f $cancel64)
        'cat /proc/sys/kernel/random/boot_id > "$cancel.boot"'
        'child=; watcher='
        'cleanup() {'
        '  trap - EXIT TERM INT HUP'
        '  if [ -n "$child" ] && kill -0 -- -"$child" 2>/dev/null; then kill -TERM -- -"$child" 2>/dev/null || :; sleep 0.2; kill -KILL -- -"$child" 2>/dev/null || :; fi'
        '  if [ -n "$watcher" ]; then kill "$watcher" 2>/dev/null || :; wait "$watcher" 2>/dev/null || :; fi'
        '  if [ -n "$child" ]; then wait "$child" 2>/dev/null || :; fi'
        '  printf complete > "$cancel.done.tmp"; mv -f -- "$cancel.done.tmp" "$cancel.done"'
        '}'
        'trap cleanup EXIT'
        'trap ''exit 124'' TERM INT HUP'
        ("setsid timeout --signal=TERM --kill-after=2s " + $Seconds + ' bash "$script" </dev/null &')
        'child=$!'
        '(while kill -0 "$child" 2>/dev/null; do if [ -e "$cancel" ]; then kill -TERM -- -"$child" 2>/dev/null || :; sleep 2; kill -KILL -- -"$child" 2>/dev/null || :; break; fi; sleep 0.2; done) &'
        'watcher=$!'
        'wait "$child"; code=$?'
        'exit "$code"'
    ) -join "`n")
}
function Assert-NoPendingWslCancellation {
    if (-not $ProgressFile) { return }
    $pending = Get-ProgressValue 'PENDING_WSL_CANCEL' '[^\r\n]+'
    if (-not $pending) { return }
    if ($pending -notmatch '[\\/]step-[a-f0-9]{32}\.sh\.cancel$') { throw 'Invalid pending installer cancellation record; check the saved progress.' }
    $closed = Test-Path -LiteralPath "$pending.done"
    if (-not $closed -and (Test-Path -LiteralPath "$pending.boot")) {
        $priorBoot = [IO.File]::ReadAllText("$pending.boot").Trim()
        $r = Invoke-BoundedWsl -Arguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--exec', 'cat', '/proc/sys/kernel/random/boot_id')
        $nowBoot = $r.Text.Trim()
        $closed = $r.Code -eq 0 -and $priorBoot -match '^[a-f0-9-]{36}$' -and $nowBoot -match '^[a-f0-9-]{36}$' -and $priorBoot -cne $nowBoot
    }
    if (-not $closed) { throw "The previous installer job has not confirmed cancellation. Do not start a second job. Let it close, or restart Windows and rerun. Cancellation receipt: $pending" }
    $keep = @([IO.File]::ReadAllLines($ProgressFile) | Where-Object { -not $_.StartsWith('PENDING_WSL_CANCEL=') })
    [IO.File]::WriteAllLines($ProgressFile, $keep)
    foreach ($suffix in @('', '.boot', '.done', '.done.tmp')) { Remove-Item -LiteralPath ($pending + $suffix) -Force -ErrorAction SilentlyContinue }
}
function Invoke-WslStep {
    param([string]$Label, [string]$Usually, [string]$Script, [double]$UpperMinutes = 0, [scriptblock]$OnLine = $null, [int]$TimeoutSeconds = 1800, [int]$NoProgressSeconds = 300, [string]$Distro = $UBUNTU_DISTRO, [string]$User = $AGEND_USER)
    Assert-NoPendingWslCancellation
    $script:LastWslStepResult = @{ Code = -1; Text = '' }
    $file, $wslFile = New-WslScriptFile $Script -Distro $Distro
    $cancel = "$file.cancel"; $wrapper = $null
    try {
        $wrapper, $wslWrapper = New-WslScriptFile (Get-OwnedWslStepScript $wslFile "$wslFile.cancel" $TimeoutSeconds) -Distro $Distro
        # Setup deliberately waits for a person; its host still has an absolute TTL.
        if ($OnLine) { $NoProgressSeconds = 0 }
        $capture = @{ Text = ''; OnLine = $OnLine }
        # GetNewClosure runs the block in a new module scope that cannot see this script's functions when the installer
        # is run as a script file (install.ps1 does): bind the one it calls as a variable first.
        $protect = ${function:Protect-LogText}
        $captureLine = { param($line)
            $capture.Text = ($capture.Text + (& $protect ([string]$line)) + "`n")
            if ($capture.Text.Length -gt 8192) { $capture.Text = $capture.Text.Substring($capture.Text.Length - 8192) }
            if ($capture.OnLine) { & $capture.OnLine $line }
        }.GetNewClosure()
        $code = Invoke-Watched -Label $Label -Usually $Usually -UpperMinutes $UpperMinutes -OnLine $captureLine -TimeoutSeconds ($TimeoutSeconds + 30) -NoProgressSeconds $NoProgressSeconds -CancellationFile $cancel -File 'wsl.exe' -Arguments @('-d', $Distro, '-u', $User, '--exec', 'bash', $wslWrapper)
        $script:LastWslStepResult = @{ Code = $code; Text = $capture.Text }
        return $code
    } finally {
        if ((Test-Path -LiteralPath $cancel) -and -not (Test-Path -LiteralPath "$cancel.done")) {
            if ($ProgressFile) { Add-Content -LiteralPath $ProgressFile -Value ("PENDING_WSL_CANCEL=" + $cancel) }
            Write-Warn "Linux 尚未確認這個步驟已停止；保留取消要求與進度，不會盲目再啟動一個。重新開機 Windows 後可再執行安裝。"
        } else {
            foreach ($f in @($file, $wrapper, $cancel, "$cancel.boot", "$cancel.done", "$cancel.done.tmp")) { if ($f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
        }
    }
}


function Clear-InstallStage([string]$stage) {
    if (-not (Test-Path -LiteralPath $ProgressFile)) { return }
    $keep = @([IO.File]::ReadAllLines($ProgressFile) | Where-Object { $_ -cne "STAGE_${stage}_DONE" })
    [IO.File]::WriteAllLines($ProgressFile, $keep)
}
function Get-VerifiedAgendVersion([string]$Expected = '') {
    # Prove the CLI, supported native Node, tmux and SQLite rather than command existence alone.
    $js = 'const cp=require("child_process"),p=require("path"),m=require("module"); const run=(b,a)=>cp.execFileSync(b,a,{encoding:"utf8",timeout:5000,stdio:["ignore","pipe","pipe"]}).trim(); const v=process.versions.node.split(".").map(Number); if(!(v[0]>=24 || v[0]===23&&v[1]>=6 || v[0]===22&&v[1]>=14))throw Error("Unsupported Node"); run("tmux",["-V"]); const root=run("npm",["root","-g"]); const r=m.createRequire(p.join(root,"@songsid/agend/package.json")); const D=r("better-sqlite3"),db=new D(":memory:");db.prepare("select 1").get();db.close(); console.log("AGEND_VERSION="+run("agend",["--version"]));'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
    $command = 'node -e ''eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString())'' ' + $encoded
    $r = Invoke-AgendInWsl $UBUNTU_DISTRO $AGEND_USER $command
    if ($r.Code -ne 0) { Write-Warn "AgEnD/Node/tmux/SQLite 驗證未通過（結束碼 $($r.Code)），此步驟不會標記完成。"; return $null }
    $m = [regex]::Match($r.Text, '(?m)^AGEND_VERSION=([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\r?$')
    if (-not $m.Success -or ($Expected -and $m.Groups[1].Value -cne $Expected)) { return $null }
    return $m.Groups[1].Value
}
function Resolve-RequestedAgendVersion([string]$Requested) {
    if ($Requested -match '^\d+\.\d+\.\d+') { return $Requested }
    $tag = if ($Requested) { $Requested } else { 'latest' }
    $r = Invoke-AgendInWsl $UBUNTU_DISTRO $AGEND_USER ('npm view @songsid/agend@' + $tag + ' version --json --fetch-timeout=15000 --fetch-retries=0')
    if ($r.Code -ne 0) { throw 'Could not resolve the requested AgEnD version; installation is not marked complete.' }
    try { $v = $r.Text | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Invalid package version metadata; installation is not marked complete.' }
    if ($v -isnot [string] -or $v -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw 'Invalid package version metadata.' }
    return $v
}
function Test-InstallerReady {
    # Probe the public sign-in page: / redirects to protected /ui and returns 401 without credentials.
    # No auth code/token is requested or printed; only local service and HTTP health are checked.
    $js = 'const cp=require("child_process"),p=require("path"),fs=require("fs"),m=require("module"); const root=cp.execFileSync("npm",["root","-g"],{encoding:"utf8",timeout:5000}).trim(); const r=m.createRequire(p.join(root,"@songsid/agend/package.json")); const cfg=r("js-yaml").load(fs.readFileSync(p.join(process.env.AGEND_HOME||p.join(require("os").homedir(),".agend"),"fleet.yaml"),"utf8")); const port=cfg.health_port??19280; if(!Number.isInteger(port)||port<1||port>65535)throw Error("Invalid dashboard port"); (async()=>{for(let i=0;i<10;i++){try{const h=await fetch("http://127.0.0.1:"+port+"/health",{signal:AbortSignal.timeout(3000)});const body=await h.json();const ui=await fetch("http://127.0.0.1:"+port+"/signin",{signal:AbortSignal.timeout(3000)});if((h.ok||h.status===503)&&(body.status==="ok"||body.status==="degraded")&&body.startupComplete===true&&ui.ok){for(const problem of (Array.isArray(body.problems)?body.problems:[]).slice(0,16)){if(typeof problem==="string")console.log("AgEnD warning: "+problem.replace(/[\r\n]/g," ").slice(0,512));}return;}}catch{}await new Promise(r=>setTimeout(r,1000));}process.exitCode=1;})();'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
    $script = $AGEND_ENV + 'systemctl --user is-active com.agend.fleet || exit $?; node -e ''eval(Buffer.from(process.argv[1],String.fromCharCode(98,97,115,101,54,52)).toString())'' ' + $encoded
    $code = Invoke-WslStep -Label '確認服務與儀表板就緒' -Usually '通常需要幾秒到 1 分鐘' -UpperMinutes 1 -TimeoutSeconds 90 -NoProgressSeconds 90 -Script $script
    return ($code -eq 0)
}


# #2650: merge only installer-owned INI keys. Keep comments, unknown sections and all unrelated values.
function Merge-InstallIni([string]$Text, [System.Collections.IDictionary]$Updates) {
    $newline = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = [Collections.Generic.List[string]]::new()
    $section = ''; $seenSections = @{}; $seenKeys = @{}
    $flush = {
        if ($Updates.Contains($section)) {
            foreach ($key in $Updates[$section].Keys) {
                $id = "$section/$key"
                if (-not $seenKeys.ContainsKey($id)) { $lines.Add("$key=$($Updates[$section][$key])"); $seenKeys[$id] = $true }
            }
        }
    }
    foreach ($line in @($Text -split '\r?\n')) {
        if ($line -match '^\s*\[([^\]]+)\]\s*(?:[#;].*)?$') {
            & $flush
            $section = $Matches[1].Trim().ToLowerInvariant(); $seenSections[$section] = $true
        }
        $next = $line
        if ($Updates.Contains($section) -and $line -match '^\s*([^#;=]+?)\s*=') {
            $key = $Matches[1].Trim().ToLowerInvariant()
            if ($Updates[$section].Contains($key)) {
                $comment = [regex]::Match($line, '\s+[#;].*$').Value
                $canonical = @($Updates[$section].Keys | Where-Object { $_.ToLowerInvariant() -eq $key })[0]
                $next = "$canonical=$($Updates[$section][$canonical])$comment"
                $seenKeys["$section/$key"] = $true
            }
        }
        $lines.Add($next)
    }
    & $flush
    foreach ($name in $Updates.Keys) {
        if (-not $seenSections.ContainsKey($name)) {
            $lines.Add(''); $lines.Add("[$name]")
            foreach ($key in $Updates[$name].Keys) { $lines.Add("$key=$($Updates[$name][$key])") }
        }
    }
    return (($lines -join $newline).TrimEnd("`r", "`n") + $newline)
}
function Write-MergedWindowsWslConfig([string]$Path) {
    $old = if (Test-Path -LiteralPath $Path) { [IO.File]::ReadAllText($Path) } else { '' }
    $next = Merge-InstallIni $old ([ordered]@{ general = [ordered]@{ instanceIdleTimeout = '-1' }; wsl2 = [ordered]@{ vmIdleTimeout = '-1' } })
    if ($next -ceq $old) { return }
    if (Test-Path -LiteralPath $Path) {
        $backup = $Path + '.agend-backup-' + [Guid]::NewGuid().ToString('N')
        [IO.File]::Copy($Path, $backup, $false)
        Write-Info "原有 WSL 設定已備份：$backup"
    }
    $temp = $Path + '.agend-' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temp, $next, (New-Object Text.UTF8Encoding $false))
        Move-Item -LiteralPath $temp -Destination $Path -Force -ErrorAction Stop
    } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}
function ConvertFrom-WslConfigSnapshot([string]$Encoded) {
    try {
        $text = (New-Object Text.UTF8Encoding $false, $true).GetString([Convert]::FromBase64String($Encoded))
        if ($text.Contains([string][char]0)) { throw 'NUL is not an INI character' }
        return $text
    } catch { throw '/etc/wsl.conf is not UTF-8 text; convert it or move it aside, then rerun. No settings were replaced.' }
}
function Get-MergedLinuxWslConfigScript([string]$Text, [string]$ExpectedBase64 = '') {
    if (-not $ExpectedBase64) { $ExpectedBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text)) }
    if ($ExpectedBase64 -notmatch '^[A-Za-z0-9+/=]*$') { throw 'Invalid WSL configuration snapshot.' }
    $next = Merge-InstallIni $Text ([ordered]@{ boot = [ordered]@{ systemd = 'true' }; interop = [ordered]@{ appendWindowsPath = 'false' }; user = [ordered]@{ default = 'root' } })
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($next))
    $nonce = [Guid]::NewGuid().ToString('N')
    return (@(
        'set -eu'
        'file=/etc/wsl.conf'
        '[ ! -L "$file" ] || { echo "Refusing to replace symlinked /etc/wsl.conf" >&2; exit 1; }'
        ('temp=/etc/.agend-wsl-' + $nonce)
        'trap ''rm -f -- "$temp"'' EXIT'
        # Match the read snapshot immediately before making a backup or replacing the file.
        ('expected=' + $ExpectedBase64)
        'actual=; if [ -e "$file" ]; then actual=$(base64 -w0 -- "$file"); fi'
        '[ "$actual" = "$expected" ] || { echo "WSL config changed; rerun installer to merge the latest settings" >&2; exit 1; }'
        ('if [ -e "$file" ]; then cp -p -- "$file" "$file.agend-backup-' + $nonce + '"; echo "WSL config backup: $file.agend-backup-' + $nonce + '"; fi')
        ("printf '%s' '" + $encoded + "' | base64 -d > " + '"$temp"')
        'if [ -e "$file" ]; then chmod --reference="$file" "$temp"; else chmod 644 "$temp"; fi'
        'mv -f -- "$temp" "$file"'
        'echo WSL_CONF_OK'
    ) -join "`n")
}

# ── 開始 ─────────────────────────────────────────────────

# Validate before any WSL, network, registry or installation action.
$AgendInstallVersion = Get-SavedInstallVersion $InstallVersion $Force.IsPresent
$AgendWslDrive = Get-SavedWslDrive $WslDrive $Force.IsPresent
Start-InstallLog $InstallRunId
# 沒有被接住的錯誤：記進安裝紀錄、說明停在哪裡，而不是只丟出一段 PowerShell 錯誤就結束（#2650 第 9 項）。
trap {
    Write-InstallLog ("unexpected error: " + $_.Exception.Message + " " + ($_.InvocationInfo.PositionMessage -replace "`r?`n", ' '))
    Set-InstallFailure 'error'
    Write-Err ("安裝程式遇到沒有預料到的錯誤，已經停下來：" + $_.Exception.Message)
    Write-Info "之後再執行同一行安裝指令，會從還沒完成的步驟繼續。"
    Read-Host "按 Enter 結束"; exit 1
}

Clear-Host
Write-Host "=" * 43 -ForegroundColor Magenta
Write-Host "   AgEnD 自動安裝程式 v3.0（多 AI 後端）" -ForegroundColor Magenta
Write-Host "=" * 43 -ForegroundColor Magenta
Write-Host ""
Write-Info "固定環境版本: $UBUNTU_DISTRO / Node.js $NODE_VERSION LTS"
Write-Host ""

if (-not (Check-Admin)) {
    Write-Err "此腳本需要以「系統管理員身分」執行！"
    Write-Info "請右鍵點擊 PowerShell →「以系統管理員身分執行」"
    Read-Host "按 Enter 結束"; exit 1
}

$identityMismatch = Get-InstallIdentityMismatch $InitiatingSid (Get-CurrentSid)
if ($identityMismatch) {
    Write-InstallIdentityMismatch $identityMismatch
    Read-Host "按 Enter 結束"; exit 1
}

# 使用這個視窗的小提醒（#1853：不熟主控台的人最常卡在這幾件事）
Write-Host "  ── 使用這個視窗前，先看這幾點 ──" -ForegroundColor Yellow
Write-Info "  複製：用滑鼠選取文字，再按右鍵（或 Enter）。"
Write-Info "  貼上：在視窗裡按一下右鍵。"
Write-Info "  請不要按 Ctrl+C：在這個視窗裡，它不是「複製」，而是「停止」。"
Write-Info "    自動安裝的步驟中不小心按到，會先問你要不要停止，不會直接中斷。"
Write-Info "  自動安裝時點到視窗也沒關係，不會讓安裝暫停。"
Write-Host ""

# 重新執行同一行安裝指令、而這台電腦已經裝好 AgEnD（不是中斷後的接續，也不是 -Force）：只更新桌面捷徑和它們的腳本，
# 不碰 WSL、後端、設定，絕不重做已經裝好的東西（#1853，給 agend update 升級上來、沒有捷徑的人）。
if (-not $Force -and -not (Test-Path $ProgressFile)) {
    $existing = Find-ExistingAgend
    if ($existing) {
        # 有 AgEnD 的資料，但 agend 指令不能用（例如更新中斷）：只修復安裝，不重新設定任何東西（#2264 的後續）。
        if ($existing.Broken) {
            Write-Warn ("這台電腦有 AgEnD（{0}，使用者 {1}），但 agend 指令無法執行。只修復安裝，不會重新設定，也不會動到 fleet 的設定和資料。" -f $existing.Distro, $existing.User)
            if (-not (Invoke-AgendRepair $existing.Distro $existing.User $existing.Version)) {
                Write-Err "修復沒有完成；你的資料和設定都還在。請看上方的原因，之後再執行同一行安裝指令。"
                Read-Host "按 Enter 結束"; exit 1
            }
            Write-Ok "AgEnD 修好了，agend 指令可以用了"
        }
        Write-Ok ("這台電腦已經裝好 AgEnD（{0}，使用者 {1}）。不會重新安裝，也不會動到現有的設定。" -f $existing.Distro, $existing.User)
        $recover = Read-Host "  需要檢查／修復設定與服務，或接續後端登入嗎？可能會啟動服務；不重設設定。(y/N)"
        if ($recover -match '^\s*[yY]\s*$') {
            if (-not (Invoke-ExistingAgendRecovery $existing.Distro $existing.User)) {
                Write-Info '仍可用桌面「AgEnD 儀表板」查看需要處理的項目；再貼一次安裝指令可重新選擇檢查／修復。'
                Read-Host "按 Enter 結束"; exit 1
            }
        }
        # 捷徑目前指向另一個 Linux 或使用者（例如 AgEnD 專用的 Linux 和原本的 Ubuntu）：先說，預設不改（絕不悄悄改指向）。
        $prior = Get-InstallRecordConflict $existing.Distro $existing.User
        if ($prior) {
            Write-Warn ("桌面捷徑目前打開的是 {0}（使用者 {1}）；更新後會改成打開 {2}（使用者 {3}）。" -f $prior.Distro, $prior.User, $existing.Distro, $existing.User)
            $ans = Read-Host "  要改成打開這個並更新桌面捷徑嗎？(y/N)"
            $update = ([string]$ans) -match '^\s*[yY]\s*$'
        } else {
            $ans = Read-Host "  要更新桌面捷徑嗎？（「AgEnD 儀表板」和「AgEnD 重新啟動」）(Y/n)"
            $update = $ans -notmatch '^\s*[nN]'
        }
        if ($update -and -not (Test-InstallRecordAsSeen $prior $existing.Distro $existing.User)) {
            Write-Warn "桌面捷徑的設定在你回答的時候被改過了，這次沒有更新捷徑；請再執行一次同一行安裝指令。"
            $update = $false
        }
        if ($update) {
            $made = @(Install-AgendShortcuts $existing.Distro $existing.User $AGEND_ICONS)
            $null = Write-ShortcutResult $made
        } else { Write-Info "沒有改動任何東西。" }
        # #2650 第 10 項：安裝完成後儀表板沒打開（或之後找不到它），再貼一次安裝指令就能打開，不用重新安裝。
        $ans = Read-Host "  要現在打開 AgEnD 網頁儀表板嗎？(Y/n)"
        if ($ans -notmatch '^\s*[nN]') { $null = Invoke-OpenDashboard $existing.Distro $existing.User }
        Write-Info "要全部重新安裝：先在這個視窗執行 `$env:AGEND_INSTALL_FORCE = '1'，再貼上同一行安裝指令。"
        Clear-ResumeAtLogon
        Read-Host "按 Enter 結束"; exit 0
    }
}

# 網路檢查：安裝真正要連的網站（見 Test-WindowsNetwork）。WSL 裡的另外在 Ubuntu 好了之後檢查。
if (-not (Test-WindowsNetwork)) {
    Write-Info "已停止，沒有改動任何東西。網路好了之後再執行同一行安裝指令。"
    Set-InstallFailure 'network'
    Read-Host "按 Enter 結束"; exit 1
}

# 這一次已經在執行：重新開機後的自動接續（如果有登記）已經用掉或不再需要。
Clear-ResumeAtLogon
Start-FreshProgress $Force.IsPresent

if ((Test-Path $ProgressFile) -and -not $Force) {
    # 上次選定的 Linux（例如沿用已經裝好的 Ubuntu-22.04）：接續時沿用，不要回到預設。
    $savedDistro = Get-ProgressValue 'DISTRO'
    if (-not $savedDistro) { $savedDistro = Get-ProgressValue 'WSL_INSTALL_DISTRO' }
    if ($savedDistro) { $UBUNTU_DISTRO = $savedDistro }
    Write-Warn "偵測到上次安裝進度，將從中斷處繼續"
    Write-Info "如需全部重新安裝：用一行指令安裝的，先執行 `$env:AGEND_INSTALL_FORCE = '1'，再貼上同一行指令；直接執行腳本的，請執行 .\install-agend.ps1 -Force"
    Write-Host ""
}

Save-InstallVersion $AgendInstallVersion
Save-WslDrive $AgendWslDrive

$TOTAL = 5

# ═══════════════════════════════════════════════════════════
# 階段 1: 安裝 WSL + Ubuntu 26.04（失敗時嘗試 24.04）
# ═══════════════════════════════════════════════════════════

Write-Step 1 $TOTAL "安裝 WSL ($UBUNTU_DISTRO)"

$wslStageVerified = $false
if (Stage-Done 1) {
    if (Get-InstalledWslVersion) {
        $currentNames = Get-WslDistroNames
        if ($null -eq $currentNames) { throw 'Cannot verify the saved WSL stage; no Linux distributions were changed.' }
        if (Clear-MissingWslTarget $currentNames) { $UBUNTU_DISTRO = 'Ubuntu-26.04'; $AgendWslDrive = Resolve-AgendWslDrive $WslDrive; Save-WslDrive $AgendWslDrive }
        $wslStageVerified = (Stage-Done 1) -and $currentNames -contains $UBUNTU_DISTRO
    }
    if (-not $wslStageVerified) { Clear-InstallStage 1 }
}
if ($wslStageVerified) {
    Write-Ok "WSL 發行版已重新確認，保留"
} else {
    # ── 1a: 安裝前檢查（組建、架構、兩個 Windows 功能、虛擬化），缺哪個功能就啟用哪個（見 Get-WslPreflight）──
    Write-Info "檢查這台電腦能不能用 WSL 2..."
    $preflight = Get-WslPreflight
    Write-Info ("Windows 組建 {0}，{1}；WSL 功能：{2}；虛擬機器平台：{3}" -f $preflight.Build, $preflight.Arch, $preflight.Features['Microsoft-Windows-Subsystem-Linux'], $preflight.Features['VirtualMachinePlatform'])
    if (-not (Test-WslPreflight $preflight)) { Read-Host "按 Enter 結束"; exit 1 }
    $featureStates = @($preflight.Features.Values)
    if ($featureStates -contains 'Unknown') {
        # 讀不到功能狀態（沒有 DISM 的 PowerShell 模組）：沿用以前的判斷，wsl --status 能用就當作已啟用。
        $statusProbe = Invoke-BoundedWsl -Arguments @('--status'); $statusOut = $statusProbe.Text
        if ($statusOut -match "Usage" -or $statusOut -match "引數") {
            foreach ($n in $WSL_FEATURES) { if ($preflight.Features[$n] -eq 'Unknown') { $preflight.Features[$n] = 'Disabled' } }
        }
    }
    if (@($preflight.Features.Values | Where-Object { $_ -ne 'Enabled' -and $_ -ne 'Unknown' }).Count -gt 0) {
        Write-Info "正在啟用 WSL 需要的 Windows 功能..."
        switch (Enable-WslFeatures $preflight.Features) {
            'failed' { Read-Host "按 Enter 結束"; exit 1 }
            'reboot' {
                Write-Ok "WSL 需要的 Windows 功能已啟用，重新開機後生效"
                Mark-Stage "1a"
                Request-Reboot "WSL 功能剛啟用，需要重新開機才能繼續"
            }
            default { Write-Ok "WSL 功能已啟用" }
        }
    } else {
        Write-Ok "WSL 功能已啟用"
    }

    # ── 1b: 更新 WSL 核心（已經是 2 以上就略過；見 Invoke-WslUpdateStage）──
    switch (Invoke-WslUpdateStage) {
        'reboot' { Request-Reboot "WSL 已安裝，需要重新開機才能生效" }
        'verify-reboot' { Mark-Stage "1b"; Request-Reboot "WSL 安裝完成，但還需要重新開機才能使用" }
        'failed' { Set-InstallFailure 'download'; Read-Host "按 Enter 結束"; exit 1 }
    }

    # ── 1c: 設定 WSL 預設版本為 2 ──
    $defaultVersion = Invoke-BoundedWsl -Arguments @('--set-default-version', '2')
    if ($defaultVersion.Code -ne 0) { throw (Get-WslFailureMessage 'Could not set the WSL default version to 2' $defaultVersion) }

    # ── 1d: 這台電腦已經有哪些 Linux（只看清單，不啟動任何一個）──
    # 之前裝過 AgEnD 專用的就沿用；有 Ubuntu 就問（建議另外裝一個）；都沒有就照常安裝 $UBUNTU_DISTRO。
    $names = Get-WslDistroNames
    if (Clear-MissingWslTarget $names) { $UBUNTU_DISTRO = 'Ubuntu-26.04'; $AgendWslDrive = Resolve-AgendWslDrive $WslDrive; Save-WslDrive $AgendWslDrive }
    $situation = Get-DistroSituation $names
    if ($situation.State -eq 'unknown') {
        Write-Err "讀不到這台電腦上的 Linux 清單。為了不動到你原本的 Linux，先停在這裡，沒有安裝或修改任何東西。"
        Write-Info "  請稍後再執行同一行安裝指令；如果一直這樣，先重新開機 Windows。"
        Read-Host "按 Enter 結束"; exit 1
    }
    $agendDistro = $situation.Agend
    $installedDistroName = $situation.Ubuntu
    $choice = 'fresh'
    if ($situation.State -eq 'reuse') { $choice = 'reuse' } elseif ($situation.State -eq 'ubuntu') { $choice = Read-DistroChoice $installedDistroName }

    if ($choice -eq 'quit') {
        Write-Info "已取消，沒有改動任何東西。"
        Read-Host "按 Enter 結束"; exit 0
    }
    if ($choice -eq 'reuse') {
        Write-Ok "沿用之前為 AgEnD 安裝的 $agendDistro（不會再裝一個）"
        $UBUNTU_DISTRO = $agendDistro
    } elseif ($choice -eq 'existing') {
        Write-Warn "會修改 $installedDistroName 的設定：開啟 systemd、預設以 root 登入、不再把 Windows 的 PATH 帶進 Linux。"
        $UBUNTU_DISTRO = $installedDistroName
    } else {
        if ($choice -eq 'separate') { $UBUNTU_DISTRO = Get-FreeAgendDistroName $names }
        $leaf = if ($choice -eq 'separate' -or $UBUNTU_DISTRO -like 'AgEnD*') { $UBUNTU_DISTRO } else { 'Ubuntu' }
        $location = Get-WslInstallLocation (Get-LocalDisks) ($env:SystemDrive + '\') $UBUNTU_DISTRO $leaf $AgendWslDrive
        $disk = $location.Disk; $wslPath = $location.Path
        Write-Ok "Linux 版本：$UBUNTU_DISTRO"
        Write-Ok ("安裝位置：{0}（可用 {1} GB）" -f $wslPath, [math]::Round($disk.Free / 1GB, 1))
        Write-Host ""

        # 安裝
        Write-Info "正在安裝 $UBUNTU_DISTRO，請不要關閉視窗..."
        $useVersionName = $UBUNTU_DISTRO -in @('Ubuntu-26.04', 'Ubuntu-24.04', 'Ubuntu-22.04')
        if (-not (Install-AgendDistro $UBUNTU_DISTRO $wslPath -UseVersionName:$useVersionName -InstalledName ([ref]$UBUNTU_DISTRO))) {
            Write-Err "Ubuntu 沒有安裝成功；你原本的 Linux 都沒有被動到。"
            Write-Info "  請確認網路正常，再執行同一行安裝指令。"
            Read-Host "按 Enter 結束"; exit 1
        }

        # The fallback may have chosen a different version name; retain its exact location on resume.
        Add-Content -LiteralPath $ProgressFile -Value ("WSL_INSTALL_DISTRO=" + $UBUNTU_DISTRO)

        # 驗證
        Write-Info "正在驗證安裝結果..."
        Start-Sleep -Seconds 3
        $wslState = Wait-WslRoot $UBUNTU_DISTRO
        if ($wslState -eq 'ready') {
            Write-Ok "$UBUNTU_DISTRO 安裝完成"
        } elseif ($wslState -eq 'declined') {
            Write-WslDeclined
            Read-Host "按 Enter 結束"; exit 1
        } else {
            Write-Err "Ubuntu 安裝失敗！"
            if ((Test-Virtualization) -eq $false) { Write-VirtualizationHint }
            Write-Info "可能原因："
            Write-Info "  - 需要重新開機（請重開機後再執行同一行安裝指令）"
            Write-Info "  - 網路問題（無法下載 Ubuntu）"
            Write-Info "  - BIOS/UEFI 的虛擬化沒有開啟，或公司的安全性原則不允許虛擬機器平台"
            Read-Host "按 Enter 結束"; exit 1
        }
    }

    Add-Content -Path $ProgressFile -Value "DISTRO=$UBUNTU_DISTRO"
    Mark-Stage 1
}

# ── 階段 1.5: WSL 環境防護 ────────────────────

# 確認 WSL 可以正常執行
$wslState = Wait-WslRoot $UBUNTU_DISTRO
if ($wslState -eq 'ready') {
    Write-Ok "WSL 已就緒"
} elseif ($wslState -eq 'declined') {
    Write-WslDeclined
    Read-Host "按 Enter 結束"; exit 1
} else {
    Write-Err "WSL 無法正常執行，請重新開機後再執行同一行安裝指令"
    Read-Host "按 Enter 結束"; exit 1
}

# 防護：設定 wsl.conf（systemd + 關閉 Windows PATH + 預設 root）
Write-Info "正在設定 WSL 環境防護..."
# Read exact bytes without introducing a PowerShell output newline.
$confRead = Invoke-BoundedWsl -Arguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--exec', 'bash', '-c', 'if [ -L /etc/wsl.conf ]; then exit 1; elif [ -e /etc/wsl.conf ]; then base64 -w0 /etc/wsl.conf; fi')
$encodedConf = $confRead.Text.Trim()
if ($confRead.Code -ne 0) { throw (Get-WslFailureMessage 'Cannot safely read /etc/wsl.conf; no settings were replaced' $confRead) }
$currentConf = ConvertFrom-WslConfigSnapshot $encodedConf
$confCode = Invoke-WslStep -Label "合併 WSL 設定（保留原有設定）" -Usually "通常幾秒鐘" -UpperMinutes 1 -Script (Get-MergedLinuxWslConfigScript $currentConf $encodedConf)
if ($confCode -ne 0) { throw (Get-WslFailureMessage 'WSL config merge failed; rerun the installer' $script:LastWslStepResult) }
Write-Ok "WSL 環境設定已合併：啟用 systemd、關閉 Windows PATH、預設使用 root；其他設定保留"
Write-Info "正在重啟選定的 Linux 讓設定生效..."
$null = Invoke-BoundedWsl -Arguments @('--terminate', $UBUNTU_DISTRO)
Start-Sleep -Seconds 2

# Merge the Windows-wide file too: never discard memory/swap/network settings.
Write-Info "正在合併 .wslconfig（保留原有的記憶體、網路等設定）..."
Write-MergedWindowsWslConfig "$env:USERPROFILE\.wslconfig"
Write-Ok ".wslconfig 已合併；原有設定保留"

# 防護：開機自動啟動 WSL（VBS 腳本放到 Startup 資料夾）
Write-Info "正在設定開機自動啟動 WSL..."
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$vbsPath = "$startupDir\start-wsl.vbs"
$vbsContent = @"
Set ws = CreateObject("WScript.Shell")
ws.Run "wsl -d $UBUNTU_DISTRO -u root -- bash -lc 'sleep infinity'", 0, False
"@
[IO.File]::WriteAllText($vbsPath, $vbsContent, (New-Object System.Text.UTF8Encoding $false))
Write-Ok "開機啟動已設定（Windows 登入後自動啟動 WSL）"

# WSL 裡的網路：還有後端或 AgEnD 要下載時才檢查（Windows 連得上不代表 WSL 也連得上，例如公司 proxy、VPN）。
if (-not ((Stage-Done 2) -and (Stage-Done 4))) {
    if (-not (Test-WslNetwork $UBUNTU_DISTRO)) {
        Write-Info "已停止。網路設定好之後再執行同一行安裝指令，會從這一步繼續。"
        Set-InstallFailure 'network'
        Read-Host "按 Enter 結束"; exit 1
    }
}

# ═══════════════════════════════════════════════════════════
# 階段 2: 安裝 AI 後端（可多選）+ PATH 設定
# ═══════════════════════════════════════════════════════════

Write-Step 2 $TOTAL "安裝 AI 後端"

$savedBackends = Get-ProgressValue 'BACKENDS' '[\d,]+'
$selected = Resolve-Backends (Get-SavedBackends)
if (@($selected).Count -eq 0) { $savedBackends = $null; Clear-InstallStage 2 }
$missingBackends = @($selected | Where-Object { -not (Get-InstalledBackend $_) })
if ((Stage-Done 2) -and $missingBackends.Count -eq 0) {
    Write-Ok ("AI 後端已驗證，保留（" + (($selected | ForEach-Object { $_.Name }) -join "、") + "）")
} else {
    Clear-InstallStage 2
    if ($savedBackends -and -not $Force) {
        $selected = Select-ResumeBackends $savedBackends
    } else {
        Write-Info "請選擇要安裝的 AI 後端（可多選，用逗號分隔）："
        foreach ($b in $ALL_BACKENDS) { Write-Info ("  {0}. {1}（{2}）" -f $b.Id, $b.Name, $b.Note) }
        $sel = Read-Host "  請輸入數字（例：1,2 或直接 Enter 選 1）"
        if ([string]::IsNullOrWhiteSpace($sel)) { $sel = "1" }
        $selected = Resolve-Backends $sel
        if (@($selected).Count -eq 0) { Write-Warn "未選擇有效後端，預設安裝 Kiro CLI"; $selected = Resolve-Backends "1" }
    }
    $selectedCsv = (($selected | ForEach-Object { $_.Id }) -join ',')
    Write-Ok ("將安裝：" + (($selected | ForEach-Object { $_.Name }) -join "、"))
    Write-Host ""

    Save-Backends $selectedCsv
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    Write-Info "  [WSL] 安裝必要套件..."
    $dependencyCode = Invoke-WslStep -Label "安裝必要套件" -Usually "通常需要 1–2 分鐘" -UpperMinutes 5 -Script 'set -e; apt-get update; apt-get install -y unzip curl git'
    if ($dependencyCode -ne 0) { throw "Required packages failed (exit $dependencyCode); backend stage remains retryable." }

    $failed = @()
    foreach ($b in $selected) {
        $have = Get-InstalledBackend $b
        if ($have) {
            Write-Ok ("{0} 已安裝（{1}），保留" -f $b.Name, $have.Version)
            if ($have.LinkedFrom) { Write-Info ("    它裝在 npm 全域（{0}），已連結到 {1}，讓 AgEnD 找得到" -f $have.LinkedFrom, $have.Path) }
            continue
        }
        Write-Info ("  [WSL] 安裝 {0}..." -f $b.Name)
        # 需要 Node 的後端（如 Codex）在 Stage 4 之前先用 nvm 引導 Node 22
        $nodePrep = ""
        if ($b.NeedsNode) {
            $nodePrep = 'export NVM_DIR=/root/.nvm; [ -s $NVM_DIR/nvm.sh ] && . $NVM_DIR/nvm.sh; if ! command -v npm >/dev/null 2>&1; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; export NVM_DIR=/root/.nvm; . $NVM_DIR/nvm.sh; nvm install 22 >/dev/null 2>&1; fi; '
        }
        $cmd = $UNATTENDED_INSTALL.Replace('__AGEND_INSTALL__', "$BACKEND_PATH; $nodePrep$($b.Install)")
        $backendCode = Invoke-WslStep -Label ("安裝 {0}" -f $b.Name) -Usually "通常需要 1–3 分鐘" -UpperMinutes 6 -Script $cmd
        $verified = if ($backendCode -eq 0) { Get-InstalledBackend $b } else { $null }
        if ($verified) { Write-Ok ("{0} 安裝完成（{1}）" -f $b.Name, $verified.Version) }
        else { Write-Warn ("{0} 尚未安裝成功（結束碼 {1}）；下次會重試" -f $b.Name, $backendCode); $failed += $b.Name }
    }

    Write-Info "  [WSL] 設定 PATH..."
    $pathScript = @'
set -e
for rc in /root/.bashrc /root/.profile; do
  if ! grep -q '.claude/local' "$rc" 2>/dev/null; then
    printf '\nexport PATH="/root/.local/bin:$HOME/.claude/local:$PATH"\n' >> "$rc"
  fi
done
'@
    $pathCode = Invoke-WslStep -Label '設定後端 PATH' -Usually '通常幾秒鐘' -UpperMinutes 1 -Script $pathScript
    if ($pathCode -ne 0) { throw "Backend PATH setup failed (exit $pathCode)." }

    Write-Host ""
    $ErrorActionPreference = $prevEAP

    if ($failed.Count -gt 0 -and $failed.Count -eq @($selected).Count) {
        Write-Err "所有選擇的後端都安裝失敗"
        Write-Info "可能原因："
        Write-Info "  - 網路連線問題（公司防火牆可能擋住下載）"
        Write-Info "  - 磁碟空間不足"
        Write-Info "解法：確認網路後重新執行腳本"
        Read-Host "按 Enter 結束"; exit 1
    }
    if ($failed.Count -gt 0) {
        Write-Warn ("部分後端安裝失敗：" + ($failed -join "、") + "（其餘已完成，可稍後手動補裝）")
    }
    Write-Ok "PATH 已設定（/root/.bashrc + /root/.profile）"
    Save-Backends $selectedCsv
    if ($failed.Count -eq 0) { Mark-Stage 2 }
}

# Progress IDs stay compatible: 4 = installed AgEnD, 3 = verified backend sign-ins.
# ═══════════════════════════════════════════════════════════
# 階段 4: 安裝 AgEnD（官方安裝腳本，含 Node.js 22）
# ═══════════════════════════════════════════════════════════

Write-Step 3 $TOTAL "安裝 AgEnD"

$requestedPin = if ($AgendInstallVersion) { $AgendInstallVersion } else { 'latest' }
$savedPin = Get-ProgressValue 'AGEND_INSTALL_REQUEST'
$savedVersion = Get-ProgressValue 'AGEND_INSTALLED_VERSION'
$installedVersion = if ((Stage-Done 4) -and $savedPin -ceq $requestedPin -and $savedVersion) { Get-VerifiedAgendVersion $savedVersion } else { $null }
if ($installedVersion) {
    Write-Ok "AgEnD $installedVersion、Node、tmux 與 SQLite 已驗證，保留"
} else {
    Clear-InstallStage 4
    Write-Info "正在安裝 AgEnD（使用官方安裝腳本 + Node.js $NODE_VERSION）..."

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    Write-Info "（正在 WSL 內執行安裝，請等待...）"
    Write-Host ""

    Write-Info "  [WSL] 安裝 tmux..."
    $tmuxCode = Invoke-WslStep -Label "安裝 tmux" -Usually "通常不到 1 分鐘" -UpperMinutes 3 -Script 'apt-get install -y -qq tmux'
    if ($tmuxCode -ne 0) { throw "tmux installation failed (exit $tmuxCode)." }

    Write-Info "  [WSL] 執行 AgEnD 官方安裝腳本（含 nvm + Node.js $NODE_VERSION + 編譯工具）..."
    $scriptLines = @(
        '#!/bin/bash'
        'set -e'
        'export HOME=/root'
        '# 官方安裝腳本（non-interactive piped 不會觸發 quickstart）'
        (Get-AgendInstallCommand $AgendInstallVersion)
        '# 確保 nvm 設定寫入 .bashrc 和 .profile'
        'if ! grep -q "NVM_DIR" /root/.bashrc 2>/dev/null; then printf "\nexport NVM_DIR=\"/root/.nvm\"\n[ -s \"\$NVM_DIR/nvm.sh\" ] && source \"\$NVM_DIR/nvm.sh\"\n" >> /root/.bashrc; fi'
        'if ! grep -q "NVM_DIR" /root/.profile 2>/dev/null; then printf "\nexport NVM_DIR=\"/root/.nvm\"\n[ -s \"\$NVM_DIR/nvm.sh\" ] && source \"\$NVM_DIR/nvm.sh\"\n" >> /root/.profile; fi'
    )
    $installCode = Invoke-WslStep -Label "安裝 AgEnD 與 Node.js" -Usually "通常需要 3–8 分鐘" -UpperMinutes 15 -Script ($scriptLines -join "`n")

    Write-Host ""

    # 獨立驗證：用 agend --version 確認安裝成功
    Write-Info "  [WSL] 驗證 AgEnD 安裝..."
    $expectedVersion = if ($installCode -eq 0) { Resolve-RequestedAgendVersion $AgendInstallVersion } else { '' }
    $verifyResult = if ($installCode -eq 0 -and $expectedVersion) { Get-VerifiedAgendVersion $expectedVersion } else { $null }
    $ErrorActionPreference = $prevEAP

    if ($verifyResult) {
        Write-Ok "AgEnD v$verifyResult 安裝完成"
        Write-Ok "Node.js $NODE_VERSION LTS + tmux 已就緒"
        Add-Content -LiteralPath $ProgressFile -Value ("AGEND_INSTALLED_VERSION=" + $verifyResult)
        Add-Content -LiteralPath $ProgressFile -Value ("AGEND_INSTALL_REQUEST=" + $requestedPin)
        Mark-Stage 4
    } else {
        Write-Err "AgEnD 安裝失敗"
        Write-Info "驗證結果: $verifyResult"
        Write-Host ""
        Write-Info "可能原因："
        Write-Info "  - npm registry 連線逾時（公司網路限制）"
        Write-Info "  - 磁碟空間不足（需約 500MB）"
        Write-Info "解法：確認網路後重新執行腳本（會自動跳過已完成步驟）"
        Read-Host "按 Enter 結束"; exit 1
    }
}

# ── Backend sign-in follows package installation (#2599). Never infer capability from a version string. ──
Write-Step 4 $TOTAL "準備瀏覽器登入"
$browserSignins = ''
$browserLogin = Test-BrowserSignInCapability $UBUNTU_DISTRO $AGEND_USER
$skippedLogins = @()
if ($browserLogin) {
    $browserSignins = Get-BrowserSignInSelection $selected
    Write-Info "Kiro、Claude、Codex 會在接下來的設定頁登入；不用在此視窗選方法或貼代碼。"
    Write-Info "可以在網頁選「Sign in later」，之後從儀表板的 Needs you 繼續。"
    if (@($selected | Where-Object { $_.Key -eq 'antigravity' }).Count) {
        Write-Warn "Antigravity 目前只提供明確的主控台備援，可稍後執行：$(Get-LoginFollowUpCommand 'antigravity')"
    }
} else {
    Write-Warn "已安裝版本尚未支援瀏覽器登入，保留主控台備援（可選略過，稍後登入）。"
    $skippedLogins = @(Complete-LoginStage $selected)
}

# ═══════════════════════════════════════════════════════════
# 階段 5: 串接通訊軟體 + 啟動服務
# ═══════════════════════════════════════════════════════════

Write-Step 5 $TOTAL "串接通訊軟體 + 啟動服務"

$script:InstallerReady = $false
if ((Stage-Done 5) -and (Test-InstallerReady)) {
    $script:InstallerReady = $true
    Write-Ok "服務與儀表板已驗證就緒"
} else {
    Write-Host ""
    Write-Info "接下來在瀏覽器裡完成設定：選擇 Discord 或 Telegram 並貼上 Bot Token；或選「Web only (no bot)」，不用 Bot、只用網頁儀表板。"
    Write-Info "設定頁會自動打開，設定碼也會幫你複製好；這個視窗不用打字。"
    if ($null -eq (Select-AgendPorts)) {
        Write-Info "之後再執行同一行安裝指令，會從這一步繼續。"
        Read-Host "按 Enter 結束"; exit 1
    }
    if (-not (Invoke-SetupAndService -BackendSignins $browserSignins -Backends $selected)) {
        Write-Info "之後再執行同一行安裝指令，會從這一步繼續。"
        Read-Host "按 Enter 結束"; exit 1
    }

    # 驗證是否啟動成功
    Write-Host ""
    Write-Info "檢查 AgEnD 狀態..."
    Start-Sleep -Seconds 5
    $status = Invoke-AgendInWsl $UBUNTU_DISTRO $AGEND_USER 'agend ls'
    if ($status.Text.Trim()) { Write-Info $status.Text.Trim() }

    $script:InstallerReady = Test-InstallerReady
    if ($script:InstallerReady) { Mark-Stage 5 } else {
        Clear-InstallStage 5
        Write-Warn "設定已儲存，但服務或儀表板尚未就緒。請查看上方錯誤、到儀表板完成登入；下次執行會重新確認，不會宣稱安裝全部成功。"
    }
}

# ═══════════════════════════════════════════════════════════
# 完成
# ═══════════════════════════════════════════════════════════

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
if ($script:InstallerReady) { Write-Host "  服務與儀表板已就緒" -ForegroundColor Green } else { Write-Warn "設定已儲存，服務或儀表板尚未就緒" }
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Info "  [OK] WSL ($UBUNTU_DISTRO) 已安裝"
# Independent auth checks: a setup Skip or an old stage marker is never sign-in proof.
$signedIn = @($selected | Where-Object { Test-WslLogin $_.Key })
$skippedLogins = @($selected | Where-Object { $b = $_; -not (@($signedIn) | Where-Object { $_.Key -eq $b.Key }) })
if ($skippedLogins.Count -eq 0) { Mark-Stage 3 }
if ($signedIn.Count -gt 0) { Write-Info ("  [OK] AI 後端已安裝並登入：" + (($signedIn | ForEach-Object { $_.Name }) -join "、")) }
foreach ($b in @($skippedLogins)) {
    if (-not (Get-InstalledBackend $b)) { Write-Warn ("  {0} 尚未安裝成功；進度會保留，再執行安裝指令會重試。" -f $b.Name); continue }
    Write-Warn ("  [!!] {0} 已安裝但還沒登入。要登入，在 PowerShell 執行：{1}" -f $b.Name, (Get-LoginFollowUpCommand $b.Key))
}
if ($script:InstallerReady) { Write-Info "  [OK] AgEnD 服務與儀表板已驗證就緒" } else { Write-Warn "  AgEnD 設定已儲存；服務與儀表板尚未通過就緒檢查" }
$connections = Get-FleetConnections $UBUNTU_DISTRO
if ($connections -eq 'web') { Write-Info "  [OK] 只用網頁儀表板（沒有串接通訊軟體；之後可在 設定 → 聊天與連線 加上 Discord 或 Telegram）" }
elseif ($connections -eq 'chat') { Write-Info "  [OK] 通訊軟體已串接" }
else { Write-Warn "  [!!] 無法確認通訊軟體是否已串接：在網頁儀表板的 設定 → 聊天與連線 可以看到" }
Write-Info "  [OK] 開機自動啟動已設定"
# 這次安裝選定的 Linux（例如另外裝的 AgEnD 專用 Linux）和捷徑原本指的不同：明說改指向哪裡。
$priorTarget = Get-InstallRecordConflict $UBUNTU_DISTRO $AGEND_USER
if ($priorTarget) { Write-Warn ("桌面捷徑原本打開 {0}（使用者 {1}），現在改成這次安裝的 {2}（使用者 {3}）。" -f $priorTarget.Distro, $priorTarget.User, $UBUNTU_DISTRO, $AGEND_USER) }
$shortcuts = @(Install-AgendShortcuts $UBUNTU_DISTRO $AGEND_USER $AGEND_ICONS)
$null = Write-ShortcutResult $shortcuts
$shortcutNames = @($shortcuts | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension([string]$_) })
Write-Host ""
Write-Host "  日常使用：" -ForegroundColor Cyan
if ($connections -eq 'web') {
    Write-Info "    在網頁儀表板跟 agent 對話；後端 CLI 要重新登入時，到 設定 → Agent → 登入 按「登入」"
} elseif ($connections -eq 'chat') {
    Write-Info "    直接在 Discord/Telegram 跟 Bot 對話即可，不需要手動開啟任何程式"
} else {
    Write-Info "    在 Discord/Telegram 跟 Bot 對話，或在網頁儀表板跟 agent 對話"
}
if ($shortcutNames -contains 'AgEnD 儀表板') { Write-Info "    要看網頁儀表板：按兩下桌面上的「AgEnD 儀表板」，登入碼會自動帶入" }
if ($shortcutNames -contains 'AgEnD 重新啟動') { Write-Info "    要重新啟動 AgEnD：按兩下「AgEnD 重新啟動」（會先問你）" }
Write-Info "    電腦重開機後 AgEnD 會自己啟動"
Write-Host ""
Write-Host "  ── 進階（需要用主控台時才看）──" -ForegroundColor DarkGray
Write-Info "    wsl -d $UBUNTU_DISTRO          # 從 PowerShell 進入 WSL"
Write-Info "    agend ls                # 查看所有 agent 狀態"
Write-Info "    agend attach <名稱>     # 進入 agent 操作畫面"
Write-Info "    agend update            # 更新到最新版"
Write-Info "    agend web               # 取得儀表板的一次性登入碼"
Write-Info ("    手動啟動：" + (Get-AgendStartHint $UBUNTU_DISTRO $AGEND_USER))
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green

# 清除進度檔與自動接續的登記
$missingBackends = @($selected | Where-Object { -not (Get-InstalledBackend $_) })
if ($script:InstallerReady -and $missingBackends.Count -eq 0) { Save-InstallReceipt 'done' @($skippedLogins | ForEach-Object { [string]$_.Key }) }
elseif ($missingBackends.Count -gt 0) { Set-InstallFailure 'backend' } else { Set-InstallFailure 'service' }
if ($script:InstallerReady -and $missingBackends.Count -eq 0) { Remove-Item -LiteralPath $ProgressFile -Force -ErrorAction SilentlyContinue }
else { Write-Info "安裝進度已保留；再次執行相同指令，會重試缺少的後端或服務檢查。" }
Clear-ResumeAtLogon

# 最後直接打開儀表板（和桌面捷徑相同的流程）。
Write-Host ""
Write-Info "正在打開 AgEnD 網頁儀表板..."
if (-not (Invoke-OpenDashboard $UBUNTU_DISTRO $AGEND_USER -BackendSignins $browserSignins)) {
    # #2650 第 10 項：安裝已經完成，只是儀表板現在打不開。說出之後打開它的兩條路（都不會重新安裝）。
    if ($script:InstallerReady -and $missingBackends.Count -eq 0) {
    Write-Info "安裝已經完成，設定都保留著。之後要打開儀表板：按兩下桌面上的「AgEnD 儀表板」，或再貼一次同一行安裝指令（不會重新安裝，會問你要不要打開儀表板）。"
    } else { Write-Info "設定與進度都保留著。可按兩下桌面的「AgEnD 儀表板」；再貼一次同一行安裝指令會從沒完成的步驟繼續。" }
}

Read-Host "按 Enter 結束"
if (-not $script:InstallerReady -or $missingBackends.Count -gt 0) { exit 1 }
