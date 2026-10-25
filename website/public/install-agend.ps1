# ═══════════════════════════════════════════════════════════
# AgEnD 一鍵安裝腳本（多 AI 後端可選）(Windows PowerShell 5)
# 需以「系統管理員身分」執行
# v3.0 - 全 root 安裝 + 官方 install.sh + systemd 服務
# ═══════════════════════════════════════════════════════════

param(
    [switch]$Force,  # 強制重新執行所有階段
    [string]$InstallVersion = $env:AGEND_VERSION,
    [string]$InstallRunId = '',  # 一行安裝指令給的這一次的代號：它讀 last.json 時，只認這一次寫的（#2650）
    [string]$InitiatingSid = ''  # 一行安裝指令（還沒提升權限時）的 Windows 帳號 SID（#2650 第 5 項）
)

$ErrorActionPreference = "Stop"
$ProgressFile = "$env:USERPROFILE\.agend-install-progress"

# ── 固定版本（避免環境不一致）──────────────────────────────
$UBUNTU_DISTRO = "Ubuntu-24.04"
$AGEND_USER = "root"  # AgEnD 安裝在這個 Linux 使用者底下（記到 install.json，捷徑用它，不寫死）
$NODE_VERSION = "22"  # LTS 穩定版，AgEnD 需要 22+

# ── 輔助函式 ─────────────────────────────────────────────

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
        return (Get-Content $ProgressFile -Raw) -match "STAGE_${stage}_DONE"
    }
    return $false
}
function Mark-Stage($stage) { Add-Content -Path $ProgressFile -Value "STAGE_${stage}_DONE" }
# 進度檔裡某個鍵最後一次存的值（沒有就 $null）。用最後一筆：同一個鍵可能存過不只一次（#2238 審查）。
function Get-ProgressValue([string]$key, [string]$pattern = '\S+') {
    if (-not (Test-Path $ProgressFile)) { return $null }
    $all = [regex]::Matches((Get-Content $ProgressFile -Raw), "(?m)^$key=($pattern)\s*$")
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
function Get-AgendInstallCommand([string]$version) {
    $version = Resolve-AgendInstallVersion $version
    $pin = ''; if ($version) { $pin = "AGEND_VERSION=$version " }
    return ('curl -fsSL https://songsid.github.io/AgEnD/install.sh | ' + $pin + 'bash || true')
}
function Get-InstallResumeCommand([string]$version) {
    $version = Resolve-AgendInstallVersion $version
    if (-not $version) { return $RESUME_COMMAND }
    return ('powershell -ExecutionPolicy ByPass -c "$env:AGEND_VERSION=' + "'$version'; " + 'irm https://songsid.github.io/AgEnD/install.ps1 | iex"')
}

# ── 重新開機後自動接續、自動選擇（#1853：使用者核准的第 ② 步）──────────────
# 需要重新開機時，登記一個「登入後執行一次」（HKCU RunOnce）：登入後自動再跑同一行安裝指令，從中斷處繼續。
# 每次安裝程式一開始就先清掉它，只在要重新開機前才登記，所以完成或失敗都不會留下舊的登記。Windows 執行它之前也會先刪掉它。
# 接續一律用一行指令（它會請你同意一次系統管理員權限），不帶 -Force：接續只是繼續，不是重來。
$RESUME_KEY = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$RESUME_NAME = 'AgEnDInstallResume'
$RESUME_COMMAND = 'powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"'
function Register-ResumeAtLogon {
    try {
        if (-not (Test-Path $RESUME_KEY)) { New-Item -Path $RESUME_KEY -Force | Out-Null }
        Set-ItemProperty -Path $RESUME_KEY -Name $RESUME_NAME -Value (Get-InstallResumeCommand $AgendInstallVersion)
        return $true
    } catch { return $false }
}
function Clear-ResumeAtLogon {
    try { Remove-ItemProperty -Path $RESUME_KEY -Name $RESUME_NAME -ErrorAction Stop } catch { }
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
function Get-LocalDisks {
    try {
        return @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop | ForEach-Object { [PSCustomObject]@{ Root = ($_.DeviceID + '\'); Free = [double]$_.FreeSpace } })
    } catch {
        return @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free } | ForEach-Object { [PSCustomObject]@{ Root = $_.Root; Free = [double]$_.Free } })
    }
}

# 以 root 確認 WSL 能用。不行時先只重新啟動這個 Linux（wsl --terminate，只動到我們自己的發行版）再試，最多兩次；
# 還是不行才問要不要重新啟動整個 WSL，預設不要。wsl --shutdown 會停掉這台電腦上所有的 Linux（其他發行版和裡面正在
# 跑的程式），所以只有明確回答 y 才執行（leader 2026-10-20：安裝程式絕不在沒有 y 的情況下執行它）。
# 不開 Ubuntu 的設定視窗：那個視窗會要你建立 Linux 使用者和密碼，而我們本來就以 root 執行。
# 回傳 'ready'、'failed'（試過了還是不行），或 'declined'（不同意重新啟動整個 WSL）。
function Test-WslRoot([string]$distro) {
    $r = wsl -d $distro -u root -- echo "WSL_OK" 2>&1 | Out-String
    return ($r -match "WSL_OK")
}
function Wait-WslRoot([string]$distro, [int]$tries = 3, [int]$pauseSeconds = 5) {
    for ($i = 1; $i -le $tries; $i++) {
        if (Test-WslRoot $distro) { return 'ready' }
        if ($i -lt $tries) {
            Write-Info "$distro 還沒準備好，只重新啟動這個 Linux 後再試一次（$i/$($tries - 1)）..."
            wsl --terminate $distro 2>&1 | Out-Null
            Start-Sleep -Seconds $pauseSeconds
        }
    }
    Write-Host ""
    $answer = Read-Host "  要重新啟動整個 WSL 嗎？這會停掉這台電腦上所有的 Linux（包括其他發行版和裡面正在跑的程式）。(y/N)"
    # 只有一個 y（前後空白可以）才算同意；y/N、yes、yesterday 都不算（#2265 審查）。[string]：沒有輸入可讀時
    # Read-Host 回傳 $null，而 $null -notmatch '…' 不是 $true，會被當成同意。
    if (([string]$answer) -notmatch '^\s*[yY]\s*$') { return 'declined' }
    Write-Info "正在重新啟動整個 WSL..."
    wsl --shutdown 2>&1 | Out-Null
    Start-Sleep -Seconds $pauseSeconds
    if (Test-WslRoot $distro) { return 'ready' }
    return 'failed'
}
# ── 另外安裝一個 AgEnD 專用的 Ubuntu（#1853，使用者 2026-10-20 實測後的要求）──────────
# 已經有 Ubuntu 的電腦：建議另外裝一個只給 AgEnD 用的（名稱 AgEnD，被占用就 AgEnD-2、AgEnD-3…），原本的完全不動。
# WSL 2.4.4 以上用 `wsl --install Ubuntu-24.04 --name <名稱> --location <位置> --no-launch`（tar 格式的發行版才能指定
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
    $prev = $env:WSL_UTF8; $prevEnc = [Console]::OutputEncoding
    try {
        $env:WSL_UTF8 = '1'
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $out = @((& wsl.exe --list --quiet 2>$null) | ForEach-Object { ("$_" -replace "`0", '').Trim() } | Where-Object { $_ })
        if ($LASTEXITCODE -eq 0) { return ,$out }
    } catch {
        # wsl.exe 不能執行：改讀登記
    } finally {
        if ($null -eq $prev) { Remove-Item Env:WSL_UTF8 -ErrorAction SilentlyContinue } else { $env:WSL_UTF8 = $prev }
        try { [Console]::OutputEncoding = $prevEnc } catch { }
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
    $ubuntu = @(@('Ubuntu-24.04', 'Ubuntu-22.04', 'Ubuntu') | Where-Object { $names -contains $_ })[0]
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
# Microsoft 發行版清單裡 Ubuntu 24.04 的官方 .wsl（這台電腦的架構）：@{ Url; Sha256 }，拿不到就 $null。
function Get-UbuntuWslImage([string]$version = 'Ubuntu-24.04') {
    try { $list = Invoke-RestMethod -Uri $DISTRO_LIST_URL -TimeoutSec 30 -UseBasicParsing } catch { return $null }
    $entry = @($list.ModernDistributions.Ubuntu | Where-Object { $_.Name -eq $version })[0]
    if (-not $entry) { return $null }
    $image = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $entry.Arm64Url } else { $entry.Amd64Url }
    if (-not $image -or -not $image.Url -or -not $image.Sha256) { return $null }
    return @{ Url = [string]$image.Url; Sha256 = (([string]$image.Sha256) -replace '^0x', '').ToUpperInvariant() }
}
# 另外安裝 AgEnD 專用的 Ubuntu，名稱 $name，放在 $location。回傳 $true：這個名稱的 Linux 已經在了。
function Install-AgendDistro([string]$name, [string]$location) {
    $version = Get-InstalledWslVersion
    if ($version -and $version -ge $WSL_NAME_MIN) {
        $null = Invoke-Watched -Label "下載並安裝 AgEnD 專用的 Ubuntu（$name）" -Usually "通常需要 3–10 分鐘" -UpperMinutes 15 -Encoding utf16 -File "wsl.exe" -Arguments @("--install", "Ubuntu-24.04", "--name", $name, "--location", $location, "--no-launch")
        $after = Get-WslDistroNames
        if ($null -eq $after) { Write-Err "裝完之後讀不到 Linux 清單，無法確認 $name 有沒有裝好；沒有再做任何事。"; return $false }
        if ($after -contains $name) { return $true }
        Write-Warn "WSL 沒有用 $name 這個名稱裝好，改用官方的 Ubuntu 映像檔匯入..."
    }
    $image = Get-UbuntuWslImage
    if (-not $image) { Write-Err "拿不到官方 Ubuntu 映像檔的清單（可能是網路問題），沒有安裝。"; return $false }
    $file = Join-Path ([IO.Path]::GetTempPath()) ("agend-ubuntu-" + [Guid]::NewGuid().ToString('N') + ".wsl")
    $prevProgress = $ProgressPreference
    try {
        Write-Info "正在下載官方的 Ubuntu 24.04（幾百 MB，請稍候）..."
        $ProgressPreference = 'SilentlyContinue'    # Windows PowerShell 5.1 的下載進度列會讓下載慢很多
        try { Invoke-WebRequest -Uri $image.Url -OutFile $file -UseBasicParsing -TimeoutSec 1800 } catch { Write-Err "下載 Ubuntu 失敗：$_"; return $false }
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash
        if ($hash -ne $image.Sha256) { Write-Err "下載的 Ubuntu 和官方的檢查碼不符，沒有安裝。"; return $false }
        New-Item -ItemType Directory -Path $location -Force | Out-Null
        $null = Invoke-Watched -Label "匯入 AgEnD 專用的 Ubuntu（$name）" -Usually "通常需要 1–3 分鐘" -UpperMinutes 10 -Encoding utf16 -File "wsl.exe" -Arguments @("--import", $name, $location, $file, "--version", "2")
        $after = Get-WslDistroNames
        return ($null -ne $after -and $after -contains $name)
    } finally {
        $ProgressPreference = $prevProgress
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
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
function Get-LoginCommand([string]$key) {
    switch ($key) {
        'kiro' { return 'kiro-cli login' }
        'claude' { return 'claude auth login' }
        'codex' { return 'codex login' }
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
    return ("wsl -d {0} -u root -- bash -lc 'export PATH=/root/.local/bin:`$PATH; source /root/.nvm/nvm.sh 2>/dev/null; agend settings confirm {1}'" -f $UBUNTU_DISTRO, $id)
}
# #2233：設定頁選了「Web only (no bot)」嗎？問 AgEnD 自己（agend validate --connections 解析 fleet.yaml，和 fleet 讀的一樣），
# 不用 grep 猜。回傳 'web'（0 個連線）、'chat'（有連線）或 'unknown'（讀不到、舊版沒有這個選項、WSL 沒回應）——不知道就不說「已串接」。
# 傳給 wsl 的指令裡沒有雙引號：Windows PowerShell 5.1 傳原生參數時會把內嵌的雙引號弄掉（#2261 審查）。
function Get-FleetConnections([string]$distro) {
    $text = ''
    $prevEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $text = ((& wsl.exe -d $distro -u root -- bash -lc 'export PATH=/root/.local/bin:$PATH; source /root/.nvm/nvm.sh 2>/dev/null; agend validate --connections' 2>&1) | ForEach-Object { "$_" } | Out-String)
    } catch {
        $text = ''
    } finally {
        $ErrorActionPreference = $prevEAP
    }
    if ($text -match '(?m)^CONNECTIONS=(\d+)\s*$') { if ([int]$Matches[1] -eq 0) { return 'web' } else { return 'chat' } }
    return 'unknown'
}
function Test-WslLogin([string]$key) {
    $r = wsl -d $UBUNTU_DISTRO -u root -- bash -lc ('export PATH=/root/.local/bin:$HOME/.claude/local:$PATH; if ' + (Get-LoginCheck $key) + '; then echo LOGIN_OK; else echo LOGIN_NO; fi') 2>&1 | Out-String
    return ($r -match 'LOGIN_OK')
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
            try { Start-Process -FilePath 'wsl.exe' -NoNewWindow -Wait -ArgumentList (Join-ProcessArguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--', 'bash', $loginWsl)) } catch { }
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
function Get-WslAgendCommand([string]$command) {
    return ('export PATH=$HOME/.local/bin:$PATH; source $HOME/.nvm/nvm.sh 2>/dev/null; ' + $command)
}
# 放進 PowerShell 文字裡的值（Linux、使用者名稱）一律用這個轉成字面字串：名稱裡的單引號（例如 o'neil）不會讓產生的
# 腳本或貼上的指令壞掉（#2260 審查）。印給人看的指令，名稱沒有特殊字元時維持原樣、不加引號。
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
        $text = ((& wsl.exe -d $distro -u $user -- bash -lc (Get-WslAgendCommand $command) 2>&1) | ForEach-Object { "$_" } | Out-String)
        $exit = $LASTEXITCODE
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

# 「AgEnD 重新啟動」捷徑（#1853，使用者 2026-10-20 核准）：先問，預設不重啟；確定才在安裝時記下的 Linux 和使用者裡執行
# agend restart，接著顯示 agend status，等你按 Enter。WSL 或 AgEnD 不在時直接說明；絕不執行 wsl --shutdown。
# 這段函式的文字同時是捷徑執行的腳本（和儀表板捷徑一樣，安裝程式與捷徑共用同一份）。
$RESTART_FN = @'
function Invoke-AgendInWsl([string]$distro, [string]$user, [string]$command) {
    # 在 WSL 裡以登入 shell 執行一個 agend 指令，回傳 @{ Code; Text }。Linux 的輸出是 UTF-8；stderr 不讓 5.1 中止（#2242）。
    $prevEAP = $ErrorActionPreference; $prevEnc = [Console]::OutputEncoding
    try {
        $ErrorActionPreference = 'Continue'
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        $text = ((& wsl.exe -d $distro -u $user -- bash -lc (Get-WslAgendCommand $command) 2>&1) | ForEach-Object { "$_" } | Out-String)
        return @{ Code = $LASTEXITCODE; Text = $text }
    } catch {
        return @{ Code = -1; Text = "$_" }
    } finally {
        $ErrorActionPreference = $prevEAP
        try { [Console]::OutputEncoding = $prevEnc } catch { }
    }
}
function Invoke-RestartAgend([string]$distro, [string]$user, [switch]$Wait, [int]$SettleSeconds = 3) {
    Write-Host ""
    $answer = Read-Host "  確定要重啟 AgEnD 嗎？所有 agent 會重新啟動，正在進行的工作會中斷。(y/N)"
    # 只有一個 y 才算同意（y/N、yes 都不算）；[string]：沒有輸入時 Read-Host 回傳 $null，而 $null -notmatch '…' 不是 $true。
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

# 捷徑執行的腳本：共用的函式加上一行呼叫（UTF-8 有 BOM：Windows PowerShell 5.1 才會正確顯示中文）。Linux 與使用者是安裝時記下的。
# 捷徑腳本印出的第一行：它要打開的 Linux 和使用者，指錯了一眼就看得出來。
function Get-ShortcutTargetLine([string]$distro, [string]$user) {
    return ('Write-Host ("AgEnD（Linux：{0}，使用者：{1}）" -f ' + (ConvertTo-PsLiteral $distro) + ', ' + (ConvertTo-PsLiteral $user) + ')')
}
function Get-DashboardOpenerScript([string]$distro, [string]$user) {
    return ("# AgEnD 儀表板（AgEnD 安裝程式建立）`n" + (Get-ShortcutTargetLine $distro $user) + "`n" + $WSL_COMMAND_FN + "`n" + $DASHBOARD_OPENER_FN + "`n" + ("Invoke-OpenDashboard {0} {1} -Wait | Out-Null" -f (ConvertTo-PsLiteral $distro), (ConvertTo-PsLiteral $user)) + "`n")
}
function Get-RestartScript([string]$distro, [string]$user) {
    return ("# AgEnD 重新啟動（AgEnD 安裝程式建立）`n" + (Get-ShortcutTargetLine $distro $user) + "`n" + $WSL_COMMAND_FN + "`n" + $RESTART_FN + "`n" + ("Invoke-RestartAgend {0} {1} -Wait | Out-Null" -f (ConvertTo-PsLiteral $distro), (ConvertTo-PsLiteral $user)) + "`n")
}
# 安裝時記下的 Linux 與使用者（%LOCALAPPDATA%\AgEnD\install.json）：捷徑、重新執行安裝指令時的快速路徑都讀它。
function Get-AgendShortcutDir { return (Join-Path $env:LOCALAPPDATA 'AgEnD') }
function Read-InstallRecord {
    try {
        $r = Get-Content -Raw -LiteralPath (Join-Path (Get-AgendShortcutDir) 'install.json') -ErrorAction Stop | ConvertFrom-Json
        if ($r.distro -and $r.user) { return @{ Distro = [string]$r.distro; User = [string]$r.user } }
    } catch { }
    return $null
}
# install.json 已經指向另一個 Linux 或使用者時回傳那筆紀錄（例如 AgEnD 專用的 Linux 和原本的 Ubuntu），否則 $null。
# 捷徑絕不悄悄改指向：agend shortcuts 遇到這種情況會先問。
function Get-InstallRecordConflict([string]$distro, [string]$user) {
    $record = Read-InstallRecord
    # WSL 的名稱不分大小寫；Linux 的使用者名稱分（Han 和 han 是兩個人，#2279 審查）。
    if ($record -and ($record.Distro -ne $distro -or $record.User -cne $user)) { return $record }
    return $null
}
# 真正寫入前再讀一次：詢問時看到的是 $seen（$null：當時沒有衝突）。現在沒有衝突，或衝突的還是同一個，才可以寫；
# 在等回答的時候被別的安裝程式或終端機改掉了，就不寫（#2279 審查）。
function Test-InstallRecordAsSeen($seen, [string]$distro, [string]$user) {
    $now = Get-InstallRecordConflict $distro $user
    if ($null -eq $now) { return $true }
    return ($null -ne $seen -and $now.Distro -eq $seen.Distro -and $now.User -ceq $seen.User)
}
# 有 Windows Terminal 時捷徑在它裡面開（中文顯示較好）；沒有或 AGEND_INSTALL_TERMINAL=conhost 時直接開 PowerShell。
function Get-ShortcutCommand([string]$file) {
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $a = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $file
    $wt = $null; if ($env:AGEND_INSTALL_TERMINAL -ne 'conhost') { $wt = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if ($wt) { return @{ Target = $wt.Source; Arguments = '-w new "{0}" {1}' -f $ps, ($a -replace ';', '\;') } }
    return @{ Target = $ps; Arguments = $a }
}
# 一個桌面捷徑：腳本寫在 %LOCALAPPDATA%\AgEnD，捷徑以 Windows PowerShell 執行它（-ExecutionPolicy Bypass 只對那個行程）。
function New-AgendShortcut([string]$name, [string]$scriptName, [string]$scriptText, [string]$description) {
    $dir = Get-AgendShortcutDir
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $file = Join-Path $dir $scriptName
    [IO.File]::WriteAllText($file, $scriptText, (New-Object System.Text.UTF8Encoding $true))
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($name + '.lnk')
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $cmd = Get-ShortcutCommand $file
    $sc.TargetPath = $cmd.Target
    $sc.Arguments = $cmd.Arguments
    $sc.Description = $description
    $sc.Save()
    return $lnk
}
# 建立（或更新）兩個桌面捷徑、記下 Linux 與使用者。兩個各自建立，一個失敗不會擋住另一個；回傳建立好的捷徑路徑，
# 呼叫端用 Write-ShortcutResult 分清楚兩個都好、只好一個、都沒好（#2252 審查）。兩個都好才在 WSL 裡留記號（agend update
# 之後的提示就不會再出現）。不是 Windows 時回傳空陣列。
function Install-AgendShortcuts([string]$distro, [string]$user) {
    if (-not $script:OnWindows) { return @() }
    $made = @()
    try { $made += New-AgendShortcut 'AgEnD 儀表板' 'open-dashboard.ps1' (Get-DashboardOpenerScript $distro $user) 'AgEnD 網頁儀表板（自動帶入登入碼）' } catch { }
    try { $made += New-AgendShortcut 'AgEnD 重新啟動' 'restart-agend.ps1' (Get-RestartScript $distro $user) '重新啟動 AgEnD（會先詢問）' } catch { }
    try {
        New-Item -ItemType Directory -Path (Get-AgendShortcutDir) -Force | Out-Null
        $record = @{ distro = $distro; user = $user } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path (Get-AgendShortcutDir) 'install.json'), $record, (New-Object System.Text.UTF8Encoding $false))
        if ($made.Count -eq 2) { $null = Invoke-AgendInWsl $distro $user 'set -f; IFS=; d=${AGEND_HOME:-$HOME/.agend}; umask 077; mkdir -p -m 700 -- $d && date -u +%FT%TZ > $d/windows-shortcuts' }
    } catch { }
    return $made
}
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
    foreach ($d in @($AGEND_DISTRO_BASE, 'Ubuntu-24.04', 'Ubuntu-22.04', 'Ubuntu')) { $candidates += ,@($d, 'root') }
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
    $cmd = Get-WslAgendCommand ('set -o pipefail; curl -fsSL https://songsid.github.io/AgEnD/install.sh | ' + $pin + 'bash')
    $code = Invoke-Watched -Label "修復 AgEnD" -Usually "通常需要 1–3 分鐘" -UpperMinutes 15 -File 'wsl.exe' -Arguments @('-d', $distro, '-u', $user, '--', 'bash', '-lc', $cmd)
    if ($code -ne 0) { return $false }
    $after = Invoke-AgendInWsl $distro $user 'agend --version'
    return ($after.Code -eq 0)
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
        Invoke-WebRequest -Uri $msiAsset.browser_download_url -OutFile $wslMsi -UseBasicParsing -TimeoutSec 1800
        $msiCode = Invoke-Watched -Label "安裝 WSL" -Usually "通常需要 1–2 分鐘" -UpperMinutes 5 -Encoding oem -File "msiexec.exe" -Arguments @("/i", $wslMsi, "/quiet", "/norestart")
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
    $null = wsl --version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { return 'verify-reboot' }
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
    $script = 'printf ''\033]0;AgEnD setup confirmation\007''; export PATH=/root/.local/bin:$PATH; source /root/.nvm/nvm.sh 2>/dev/null; agend settings confirm ' + $id + '; echo; read -r -p ''Press Enter to close this window. '' _'
    try {
        $null = Start-Process -FilePath 'wsl.exe' -ArgumentList (Join-ProcessArguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--', 'bash', '-lc', $script))
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
function Show-SetupCode([string]$code, [bool]$copied, [bool]$opened, [string]$url) {
    $spaced = ($code.ToCharArray() | ForEach-Object { [string]$_ }) -join ' '
    Write-Host ""
    Write-Host "  ┌──────────────────────────────────────┐" -ForegroundColor Green
    Write-Host ("  │   設定碼：  " + $spaced + "    │") -ForegroundColor Green
    Write-Host "  └──────────────────────────────────────┘" -ForegroundColor Green
    if ($opened) { Write-Ok "設定頁已在瀏覽器打開。" } else { Write-Warn "瀏覽器沒有自動打開，請自己打開下面的網址。" }
    # #2650 第 10 項：網址一定印出來。瀏覽器開到別的視窗、別的帳號，或分頁被關掉時，都可以複製它重新打開。
    Write-Host ("  設定頁網址：" + $url) -ForegroundColor White                   # Write-Host：不進安裝紀錄檔（網址含這次設定的路徑）
    if ($copied) { Write-Ok "設定碼已複製：在網頁的輸入框按 Ctrl+V（或右鍵 → 貼上）。" } else { Write-Info "在網頁的輸入框輸入上面的設定碼。" }
    Write-Info "在網頁上選擇 Discord 或 Telegram 並貼上 Bot Token，或選「Web only (no bot)」只用網頁；最後按完成。這個視窗會等你，不用在這裡打字。"
    Write-Info "設定頁最多開 15 分鐘（10 分鐘沒有操作也會關閉）。關掉了也沒關係：回到這個視窗按 Enter 就會重新打開，已經完成的後端登入不用重來。"
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
            $opened = Open-InBrowser $setupSeen.Url
            Show-SetupCode $setupSeen.Code $copied $opened $setupSeen.Url
        }
    }
    $exit = & $Run $hook
    return @{ Exit = $exit; Done = $setupSeen.Done; Already = $setupSeen.Already; Shown = $setupSeen.Shown; Stopped = $setupSeen.Stopped }
}

# 第 5 階段的設定與服務（#2235 審查：每一步都要命令成功才算完成）。回傳 $true 才可以標記完成；$false 表示使用者選擇結束，
# 進度保留，下次執行同一行指令會從這一步繼續。
$AGEND_ENV = 'export PATH=/root/.local/bin:$PATH; source /root/.nvm/nvm.sh 2>/dev/null; umask 077; node --input-type=commonjs -e ''`use strict`;  var fs = require(`fs`); var path = require(`path`);  function checkedPath(dir, io, missingAllowed, message) {   var absolute = path.resolve(dir), parent = path.parse(absolute).root;   var pieces = absolute.slice(parent.length).split(path.sep).filter(Boolean), info;   for (var i = 0; i < pieces.length; i++) {     parent = path.join(parent, pieces[i]);     try { info = io.lstatSync(parent); }     catch (error) { if (missingAllowed && error.code === `ENOENT`) return null; throw error; }     if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(message);   }   return info || io.lstatSync(absolute); }  /** Create privately; repair only an owned real home, never chmod by pathname or through a symlink. */ function ensurePrivateHome(dir, options) {   var opts = options || {}, io = opts.fs || fs;   var uid = opts.uid === undefined ? (typeof process.getuid === `function` ? process.getuid() : null) : opts.uid;   var label = opts.label || `AgEnD`;   var message = label + ` requires an owned real AGEND_HOME without group/other write permission.`;   checkedPath(dir, io, opts.create !== false, message);   if (opts.create !== false) io.mkdirSync(dir, { recursive: true, mode: 448 });    var before = checkedPath(dir, io, false, message);      if (uid === null) return;   if (before.uid !== uid) throw new Error(message);   var fd = io.openSync(dir, io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW);   try {     if (opts.afterOpen) opts.afterOpen();      var info = io.fstatSync(fd), current = checkedPath(dir, io, false, message);     if (!info.isDirectory() || info.uid !== uid || current.dev !== info.dev || current.ino !== info.ino) throw new Error(message);     if (info.mode & 18) {        io.fchmodSync(fd, 448);       if ((io.fstatSync(fd).mode & 511) !== 448) throw new Error(message);       (opts.log || function (line) { console.warn(line); })(`AgEnD: tightened owned AGEND_HOME permissions to 0700.`);     }   } finally { io.closeSync(fd); } }  module.exports = { ensurePrivateHome: ensurePrivateHome }; ensurePrivateHome(process.env.AGEND_HOME || path.join(require(`os`).homedir(), `.agend`));'' || exit $?; '
# 主控台版的 quickstart：子程序直接接在這個視窗上（它的提示和你的輸入都在這裡），函式只回傳它的結束碼。不能直接在
# 函式裡執行 wsl：原生程式的輸出會進到函式的回傳值，提示就看不到，結束碼也會變成一個陣列（#2235 審查）。
function Invoke-ConsoleQuickstart {
    Write-Warn "要貼上 Bot Token：在視窗裡按一下右鍵。"
    Write-Warn "設定時請不要按 Ctrl+C：它會直接結束設定。"
    try {
        $p = Start-Process -FilePath 'wsl.exe' -NoNewWindow -Wait -PassThru `
            -ArgumentList (Join-ProcessArguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--', 'bash', '-lc', ($AGEND_ENV + 'agend quickstart')))
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
__AGEND_INSTALL__
}
if command -v setsid >/dev/null 2>&1; then
  setsid -w bash -c "$(declare -f agend_install); agend_install" </dev/null
else
  agend_install </dev/null
fi
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
    $out = (wsl -d $UBUNTU_DISTRO -u root -- bash -c $BACKEND_PROBE.Replace('__BIN__', $b.Bin) 2>$null | Out-String)
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
function Invoke-Watched {
    param([string]$Label, [string]$Usually, [string]$File, [string[]]$Arguments = @(), [double]$UpperMinutes = 0, [int]$HeartbeatSeconds = 30,
        [string]$Encoding = 'utf8', [scriptblock]$OnLine = $null)
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
    $st = @{ Tails = @((New-OutputTail $outFile $Encoding), (New-OutputTail $errFile $Encoding)); Pending = @('', ''); Progress = ''; Shown = $false; Row = $null }
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
            if ($null -ne $consoleSaved) {
                while ($null -ne ($key = Read-StepKey)) {
                    if (Test-CtrlC $key) {
                        & $clearStatus
                        if (Confirm-StopInstall $proc) {
                            Restore-StepConsole $consoleSaved; $consoleSaved = $null
                            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
                            exit 1
                        }
                    }
                }
            }
            if ($live) {
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
function Confirm-StopInstall($proc) {
    Write-Host ""
    Write-Warn "你按了 Ctrl+C。在這個視窗裡，Ctrl+C 是「停止」，不是「複製」。"
    Write-Warn "安裝還在背景繼續進行，沒有中斷。"
    Write-Host "  要停止安裝嗎？輸入 y 再按 Enter 就停止；直接按 Enter 會繼續。" -ForegroundColor Yellow -NoNewline
    $answer = Read-Answer
    if (([string]$answer) -match '^\s*[yY]\s*$') {
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

# 把一段 bash 腳本寫到沒有空白的 ProgramData 路徑（LF、UTF-8 無 BOM），回傳 Windows 路徑和 WSL 裡的路徑。
function New-WslScriptFile([string]$Script) {
    $dir = Join-Path $env:ProgramData 'AgEnD-install'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $file = Join-Path $dir ('step-' + [Guid]::NewGuid().ToString('N') + '.sh')
    [IO.File]::WriteAllText($file, ($Script -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
    $wslFile = (wsl -d $UBUNTU_DISTRO -u root -- wslpath -u ($file -replace '\\', '\\') 2>$null | Out-String).Trim()
    if (-not $wslFile.StartsWith('/')) { $wslFile = '/mnt/' + $file.Substring(0, 1).ToLower() + ($file.Substring(2) -replace '\\', '/') }
    return @($file, $wslFile)
}
# 在 WSL 裡以 root 執行一段 bash 腳本，作為長步驟（見 Invoke-Watched）。
function Invoke-WslStep {
    param([string]$Label, [string]$Usually, [string]$Script, [double]$UpperMinutes = 0, [scriptblock]$OnLine = $null)
    $file, $wslFile = New-WslScriptFile $Script
    try {
        return (Invoke-Watched -Label $Label -Usually $Usually -UpperMinutes $UpperMinutes -OnLine $OnLine -File 'wsl.exe' -Arguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--', 'bash', $wslFile))
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
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
            $made = @(Install-AgendShortcuts $existing.Distro $existing.User)
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

# 網路檢查
Write-Info "檢查網路連線..."
try {
    $null = Invoke-WebRequest -Uri "https://www.google.com" -TimeoutSec 10 -UseBasicParsing
    Write-Ok "網路連線正常"
} catch {
    Write-Err "無法連線到網路！請確認網路後重試"
    Read-Host "按 Enter 結束"; exit 1
}

# 這一次已經在執行：重新開機後的自動接續（如果有登記）已經用掉或不再需要。
Clear-ResumeAtLogon
Start-FreshProgress $Force.IsPresent

if ((Test-Path $ProgressFile) -and -not $Force) {
    # 上次選定的 Linux（例如沿用已經裝好的 Ubuntu-22.04）：接續時沿用，不要回到預設。
    $savedDistro = Get-ProgressValue 'DISTRO'
    if ($savedDistro) { $UBUNTU_DISTRO = $savedDistro }
    Write-Warn "偵測到上次安裝進度，將從中斷處繼續"
    Write-Info "如需全部重新安裝：用一行指令安裝的，先執行 `$env:AGEND_INSTALL_FORCE = '1'，再貼上同一行指令；直接執行腳本的，請執行 .\install-agend.ps1 -Force"
    Write-Host ""
}

Save-InstallVersion $AgendInstallVersion

$TOTAL = 5

# ═══════════════════════════════════════════════════════════
# 階段 1: 安裝 WSL + Ubuntu 24.04
# ═══════════════════════════════════════════════════════════

Write-Step 1 $TOTAL "安裝 WSL ($UBUNTU_DISTRO)"

if (Stage-Done 1) {
    Write-Ok "WSL 已安裝，跳過此步驟"
} else {
    # ── 1a: 安裝前檢查（組建、架構、兩個 Windows 功能、虛擬化），缺哪個功能就啟用哪個（見 Get-WslPreflight）──
    Write-Info "檢查這台電腦能不能用 WSL 2..."
    $preflight = Get-WslPreflight
    Write-Info ("Windows 組建 {0}，{1}；WSL 功能：{2}；虛擬機器平台：{3}" -f $preflight.Build, $preflight.Arch, $preflight.Features['Microsoft-Windows-Subsystem-Linux'], $preflight.Features['VirtualMachinePlatform'])
    if (-not (Test-WslPreflight $preflight)) { Read-Host "按 Enter 結束"; exit 1 }
    $featureStates = @($preflight.Features.Values)
    if ($featureStates -contains 'Unknown') {
        # 讀不到功能狀態（沒有 DISM 的 PowerShell 模組）：沿用以前的判斷，wsl --status 能用就當作已啟用。
        $statusOut = wsl --status 2>&1 | Out-String
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
    wsl --set-default-version 2 2>&1 | Out-Null

    # ── 1d: 這台電腦已經有哪些 Linux（只看清單，不啟動任何一個）──
    # 之前裝過 AgEnD 專用的就沿用；有 Ubuntu 就問（建議另外裝一個）；都沒有就照常安裝 $UBUNTU_DISTRO。
    $names = Get-WslDistroNames
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
        # 安裝位置見 Select-InstallDrive，不必再輸入數字。
        $disk = Select-InstallDrive (Get-LocalDisks) ($env:SystemDrive + '\')
        if (-not $disk) {
            Write-Err "找不到可用空間 5 GB 以上的本機磁碟，無法安裝 Linux"
            Write-Info "請先清出一些空間，再執行同一行安裝指令"
            Read-Host "按 Enter 結束"; exit 1
        }
        $wslPath = if ($choice -eq 'separate') { "$($disk.Root)WSL\$UBUNTU_DISTRO" } else { "$($disk.Root)WSL\Ubuntu" }
        Write-Ok "Linux 版本：$UBUNTU_DISTRO"
        Write-Ok ("安裝位置：{0}（可用 {1} GB）" -f $wslPath, [math]::Round($disk.Free / 1GB, 1))
        Write-Host ""

        # 安裝
        Write-Info "正在安裝 $UBUNTU_DISTRO，請不要關閉視窗..."
        if ($choice -eq 'separate') {
            if (-not (Install-AgendDistro $UBUNTU_DISTRO $wslPath)) {
                Write-Err "AgEnD 專用的 Ubuntu 沒有安裝成功；你原本的 Linux 都沒有被動到。"
                Write-Info "  請確認網路正常，再執行同一行安裝指令。"
                Read-Host "按 Enter 結束"; exit 1
            }
        } else {
            $null = Invoke-Watched -Label "下載並安裝 $UBUNTU_DISTRO" -Usually "通常需要 3–10 分鐘" -UpperMinutes 15 -Encoding utf16 -File "wsl.exe" -Arguments @("--install", "-d", $UBUNTU_DISTRO, "--location", $wslPath, "--no-launch")
            # 較舊的 WSL 不認得 --location，或安裝沒有成功：和另外安裝時一樣，改用官方映像檔匯入（#2650 第 7 項）。
            $afterFresh = Get-WslDistroNames
            if ($null -ne $afterFresh -and $afterFresh -notcontains $UBUNTU_DISTRO) {
                Write-Warn "$UBUNTU_DISTRO 沒有用這個方式裝好，改用官方的 Ubuntu 映像檔..."
                if (-not (Install-AgendDistro $UBUNTU_DISTRO $wslPath)) {
                    Write-Err "$UBUNTU_DISTRO 沒有安裝成功。"
                    Write-Info "  請確認網路正常，再執行同一行安裝指令。"
                    Read-Host "按 Enter 結束"; exit 1
                }
            }
        }

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
$encodedConf = (wsl -d $UBUNTU_DISTRO -u root -- bash -c 'if [ -L /etc/wsl.conf ]; then exit 1; elif [ -e /etc/wsl.conf ]; then base64 -w0 /etc/wsl.conf; fi' 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot safely read /etc/wsl.conf; no settings were replaced.' }
$currentConf = ConvertFrom-WslConfigSnapshot $encodedConf
$confCode = Invoke-WslStep -Label "合併 WSL 設定（保留原有設定）" -Usually "通常幾秒鐘" -UpperMinutes 1 -Script (Get-MergedLinuxWslConfigScript $currentConf $encodedConf)
if ($confCode -ne 0) { throw "WSL config merge failed (exit $confCode); review the error above and rerun." }
Write-Ok "WSL 環境設定已合併：啟用 systemd、關閉 Windows PATH、預設使用 root；其他設定保留"
Write-Info "正在重啟選定的 Linux 讓設定生效..."
wsl --terminate $UBUNTU_DISTRO 2>$null
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

# ═══════════════════════════════════════════════════════════
# 階段 2: 安裝 AI 後端（可多選）+ PATH 設定
# ═══════════════════════════════════════════════════════════

Write-Step 2 $TOTAL "安裝 AI 後端"

if (Stage-Done 2) {
    $selected = Resolve-Backends (Get-SavedBackends)
    Write-Ok ("AI 後端已安裝，跳過此步驟（" + (($selected | ForEach-Object { $_.Name }) -join "、") + "）")
} else {
    Write-Host ""
    Write-Info "請選擇要安裝的 AI 後端（可多選，用逗號分隔）："
    Write-Host ""
    foreach ($b in $ALL_BACKENDS) {
        Write-Info ("  {0}. {1,-16}（{2}）" -f $b.Id, $b.Name, $b.Note)
    }
    Write-Host ""
    $sel = Read-Host "  請輸入數字（例：1,2 或直接 Enter 選 1）"
    if ([string]::IsNullOrWhiteSpace($sel)) { $sel = "1" }  # 向後相容：預設 Kiro CLI
    $selected = Resolve-Backends $sel
    if (@($selected).Count -eq 0) {
        Write-Warn "未選擇有效後端，預設安裝 Kiro CLI"
        $selected = Resolve-Backends "1"
    }
    $selectedCsv = (($selected | ForEach-Object { $_.Id }) -join ',')
    Write-Ok ("將安裝：" + (($selected | ForEach-Object { $_.Name }) -join "、"))
    Write-Host ""

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    Write-Info "  [WSL] 安裝必要套件..."
    $null = Invoke-WslStep -Label "安裝必要套件" -Usually "通常需要 1–2 分鐘" -UpperMinutes 5 -Script 'apt-get install -y unzip curl git || true'

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
        $null = Invoke-WslStep -Label ("安裝 {0}" -f $b.Name) -Usually "通常需要 1–3 分鐘" -UpperMinutes 6 -Script $cmd
        $check = wsl -d $UBUNTU_DISTRO -u root -- bash -lc "$BACKEND_PATH; if command -v $($b.Bin) >/dev/null 2>&1; then echo OK; else echo FAIL; fi" 2>&1 | Out-String
        if ($check -match "OK") { Write-Ok ("{0} 安裝完成" -f $b.Name) }
        else { Write-Warn ("{0} 安裝可能失敗（找不到 {1}）" -f $b.Name, $b.Bin); $failed += $b.Name }
    }

    Write-Info "  [WSL] 設定 PATH..."
    wsl -d $UBUNTU_DISTRO -u root -- bash -c 'if ! grep -q ".claude/local" /root/.bashrc 2>/dev/null; then echo "export PATH=\"/root/.local/bin:\$HOME/.claude/local:\$PATH\"" >> /root/.bashrc; fi' 2>&1 | Out-Null
    wsl -d $UBUNTU_DISTRO -u root -- bash -c 'if ! grep -q ".claude/local" /root/.profile 2>/dev/null; then echo "export PATH=\"/root/.local/bin:\$HOME/.claude/local:\$PATH\"" >> /root/.profile; fi' 2>&1 | Out-Null

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
    Mark-Stage 2
}

# Progress IDs stay compatible: 4 = installed AgEnD, 3 = verified backend sign-ins.
# ═══════════════════════════════════════════════════════════
# 階段 4: 安裝 AgEnD（官方安裝腳本，含 Node.js 22）
# ═══════════════════════════════════════════════════════════

Write-Step 3 $TOTAL "安裝 AgEnD"

if (Stage-Done 4) {
    Write-Ok "AgEnD 已安裝，跳過此步驟"
} else {
    Write-Info "正在安裝 AgEnD（使用官方安裝腳本 + Node.js $NODE_VERSION）..."

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    Write-Info "（正在 WSL 內執行安裝，請等待...）"
    Write-Host ""

    Write-Info "  [WSL] 安裝 tmux..."
    $null = Invoke-WslStep -Label "安裝 tmux" -Usually "通常不到 1 分鐘" -UpperMinutes 3 -Script 'apt-get install -y -qq tmux || true'

    Write-Info "  [WSL] 執行 AgEnD 官方安裝腳本（含 nvm + Node.js $NODE_VERSION + 編譯工具）..."
    $scriptLines = @(
        '#!/bin/bash'
        'export HOME=/root'
        '# 官方安裝腳本（non-interactive piped 不會觸發 quickstart）'
        (Get-AgendInstallCommand $AgendInstallVersion)
        '# 確保 nvm 設定寫入 .bashrc 和 .profile'
        'if ! grep -q "NVM_DIR" /root/.bashrc 2>/dev/null; then printf "\nexport NVM_DIR=\"/root/.nvm\"\n[ -s \"\$NVM_DIR/nvm.sh\" ] && source \"\$NVM_DIR/nvm.sh\"\n" >> /root/.bashrc; fi'
        'if ! grep -q "NVM_DIR" /root/.profile 2>/dev/null; then printf "\nexport NVM_DIR=\"/root/.nvm\"\n[ -s \"\$NVM_DIR/nvm.sh\" ] && source \"\$NVM_DIR/nvm.sh\"\n" >> /root/.profile; fi'
    )
    $null = Invoke-WslStep -Label "安裝 AgEnD 與 Node.js" -Usually "通常需要 3–8 分鐘" -UpperMinutes 15 -Script ($scriptLines -join "`n")

    Write-Host ""

    # 獨立驗證：用 agend --version 確認安裝成功
    Write-Info "  [WSL] 驗證 AgEnD 安裝..."
    $verifyResult = wsl -d $UBUNTU_DISTRO -u root -- bash -c 'agend --version 2>/dev/null' 2>&1 | Out-String
    $verifyResult = $verifyResult.Trim()
    $ErrorActionPreference = $prevEAP

    if ($verifyResult -match "^\d+\.\d+") {
        Write-Ok "AgEnD v$verifyResult 安裝完成"
        Write-Ok "Node.js $NODE_VERSION LTS + tmux 已就緒"
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

if (Stage-Done 5) {
    Write-Ok "已完成，跳過此步驟"
} else {
    Write-Host ""
    Write-Info "接下來在瀏覽器裡完成設定：選擇 Discord 或 Telegram 並貼上 Bot Token；或選「Web only (no bot)」，不用 Bot、只用網頁儀表板。"
    Write-Info "設定頁會自動打開，設定碼也會幫你複製好；這個視窗不用打字。"
    if (-not (Invoke-SetupAndService -BackendSignins $browserSignins -Backends $selected)) {
        Write-Info "之後再執行同一行安裝指令，會從這一步繼續。"
        Read-Host "按 Enter 結束"; exit 1
    }

    # 驗證是否啟動成功
    Write-Host ""
    Write-Info "檢查 AgEnD 狀態..."
    Start-Sleep -Seconds 5
    wsl -d $UBUNTU_DISTRO -u root -- bash -lc 'export PATH=/root/.local/bin:$PATH; source /root/.nvm/nvm.sh 2>/dev/null; agend ls' 2>&1 | ForEach-Object {
        $line = $_.ToString().Trim()
        if ($line -match "\S" -and $line -notmatch "RemoteException") { Write-Info "  $line" }
    }

    Mark-Stage 5
}

# ═══════════════════════════════════════════════════════════
# 完成
# ═══════════════════════════════════════════════════════════

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  全部安裝完成！" -ForegroundColor Green
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Info "  [OK] WSL ($UBUNTU_DISTRO) 已安裝"
# Independent auth checks: a setup Skip or an old stage marker is never sign-in proof.
$signedIn = @($selected | Where-Object { Test-WslLogin $_.Key })
$skippedLogins = @($selected | Where-Object { $b = $_; -not (@($signedIn) | Where-Object { $_.Key -eq $b.Key }) })
if ($skippedLogins.Count -eq 0) { Mark-Stage 3 }
if ($signedIn.Count -gt 0) { Write-Info ("  [OK] AI 後端已安裝並登入：" + (($signedIn | ForEach-Object { $_.Name }) -join "、")) }
foreach ($b in @($skippedLogins)) {
    Write-Warn ("  [!!] {0} 已安裝但還沒登入。要登入，在 PowerShell 執行：{1}" -f $b.Name, (Get-LoginFollowUpCommand $b.Key))
}
Write-Info "  [OK] AgEnD 已安裝並啟動（systemd 服務）"
$connections = Get-FleetConnections $UBUNTU_DISTRO
if ($connections -eq 'web') { Write-Info "  [OK] 只用網頁儀表板（沒有串接通訊軟體；之後可在 設定 → 聊天與連線 加上 Discord 或 Telegram）" }
elseif ($connections -eq 'chat') { Write-Info "  [OK] 通訊軟體已串接" }
else { Write-Warn "  [!!] 無法確認通訊軟體是否已串接：在網頁儀表板的 設定 → 聊天與連線 可以看到" }
Write-Info "  [OK] 開機自動啟動已設定"
# 這次安裝選定的 Linux（例如另外裝的 AgEnD 專用 Linux）和捷徑原本指的不同：明說改指向哪裡。
$priorTarget = Get-InstallRecordConflict $UBUNTU_DISTRO $AGEND_USER
if ($priorTarget) { Write-Warn ("桌面捷徑原本打開 {0}（使用者 {1}），現在改成這次安裝的 {2}（使用者 {3}）。" -f $priorTarget.Distro, $priorTarget.User, $UBUNTU_DISTRO, $AGEND_USER) }
$shortcuts = @(Install-AgendShortcuts $UBUNTU_DISTRO $AGEND_USER)
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
Save-InstallReceipt 'done' @($skippedLogins | ForEach-Object { [string]$_.Key })

# 清除進度檔與自動接續的登記
Remove-Item $ProgressFile -Force -ErrorAction SilentlyContinue
Clear-ResumeAtLogon

# 最後直接打開儀表板（和桌面捷徑相同的流程）。
Write-Host ""
Write-Info "正在打開 AgEnD 網頁儀表板..."
if (-not (Invoke-OpenDashboard $UBUNTU_DISTRO $AGEND_USER -BackendSignins $browserSignins)) {
    # #2650 第 10 項：安裝已經完成，只是儀表板現在打不開。說出之後打開它的兩條路（都不會重新安裝）。
    Write-Info "安裝已經完成，設定都保留著。之後要打開儀表板：按兩下桌面上的「AgEnD 儀表板」，或再貼一次同一行安裝指令（不會重新安裝，會問你要不要打開儀表板）。"
}

Read-Host "按 Enter 結束"

