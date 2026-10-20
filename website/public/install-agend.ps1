# ═══════════════════════════════════════════════════════════
# AgEnD 一鍵安裝腳本（多 AI 後端可選）(Windows PowerShell 5)
# 需以「系統管理員身分」執行
# v3.0 - 全 root 安裝 + 官方 install.sh + systemd 服務
# ═══════════════════════════════════════════════════════════

param(
    [switch]$Force  # 強制重新執行所有階段
)

$ErrorActionPreference = "Stop"
$ProgressFile = "$env:USERPROFILE\.agend-install-progress"

# ── 固定版本（避免環境不一致）──────────────────────────────
$UBUNTU_DISTRO = "Ubuntu-24.04"
$NODE_VERSION = "22"  # LTS 穩定版，AgEnD 需要 22+

# ── 輔助函式 ─────────────────────────────────────────────

function Write-Step($num, $total, $msg) {
    Write-Host "`n[$num/$total] $msg" -ForegroundColor Cyan
}
function Write-Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "  [X] $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  $msg" -ForegroundColor White }

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
        Set-ItemProperty -Path $RESUME_KEY -Name $RESUME_NAME -Value $RESUME_COMMAND
        return $true
    } catch { return $false }
}
function Clear-ResumeAtLogon {
    try { Remove-ItemProperty -Path $RESUME_KEY -Name $RESUME_NAME -ErrorAction Stop } catch { }
}
# 要重新開機時：登記接續，說明會發生什麼，問一次要不要現在重開。
function Request-Reboot([string]$why) {
    Write-Warn $why
    $registered = Register-ResumeAtLogon
    if ($registered) {
        Write-Info "重新開機並登入 Windows 後，安裝會自動繼續（會先跳出一個 Windows 確認視窗，請選「是」）。"
    } else {
        Write-Info "重新開機後，請再執行一次同一行安裝指令，會從中斷處繼續。"
    }
    $reboot = Read-Host "  按 Enter 立刻重新開機；輸入 n 再按 Enter 先不重開"
    if ($reboot -notmatch '^\s*[nN]') { Restart-Computer -Force }
    if ($registered) { Write-Info "好的。之後你自己重新開機，登入後一樣會自動繼續。" }
    exit 0
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

# 以 root 確認 WSL 能用；不行就整個重新啟動 WSL（wsl --shutdown）再試，最多三次。不開 Ubuntu 的設定視窗：
# 那個視窗會要你建立 Linux 使用者和密碼（輸入密碼時畫面不顯示任何字），而我們本來就以 root 執行。
function Wait-WslRoot([string]$distro, [int]$tries = 3, [int]$pauseSeconds = 5) {
    for ($i = 1; $i -le $tries; $i++) {
        $r = wsl -d $distro -u root -- echo "WSL_OK" 2>&1 | Out-String
        if ($r -match "WSL_OK") { return $true }
        if ($i -lt $tries) {
            Write-Info "WSL 還沒準備好，重新啟動 WSL 後再試一次（$i/$($tries - 1)）..."
            wsl --shutdown 2>&1 | Out-Null
            Start-Sleep -Seconds $pauseSeconds
        }
    }
    return $false
}

# ── 在瀏覽器裡設定（#1853：取代主控台裡的 agend quickstart）─────────────
# agend setup 在 WSL 裡開一個設定頁，印出網址和設定碼。安裝程式讀到這兩行，就在 Windows 的瀏覽器打開網址、
# 把設定碼放進剪貼簿並放大顯示；使用者在網頁上選 Discord 或 Telegram、貼上 Bot Token，不必在這個視窗打字。
# WSL 2 預設會把 localhost 轉給 Windows，所以 Windows 的瀏覽器開得了 127.0.0.1 的網址。
function Get-SetupPrompt([string]$line) {
    if ($line -match 'Setup page:\s*(https?://\S+)') { return @{ Url = $Matches[1] } }
    if ($line -match 'Setup code:\s*([A-Z2-7]{4}-[A-Z2-7]{4})') { return @{ Code = $Matches[1] } }
    return $null
}
function Open-InBrowser([string]$url) { try { Start-Process $url; return $true } catch { return $false } }
function Set-SetupClipboard([string]$text) { try { Set-Clipboard -Value $text; return $true } catch { return $false } }
function Show-SetupCode([string]$code, [bool]$copied, [bool]$opened, [string]$url) {
    $spaced = ($code.ToCharArray() | ForEach-Object { [string]$_ }) -join ' '
    Write-Host ""
    Write-Host "  ┌──────────────────────────────────────┐" -ForegroundColor Green
    Write-Host ("  │   設定碼：  " + $spaced + "    │") -ForegroundColor Green
    Write-Host "  └──────────────────────────────────────┘" -ForegroundColor Green
    if ($opened) { Write-Ok "設定頁已在瀏覽器打開。" } else { Write-Warn "瀏覽器沒有自動打開，請自己打開這個網址：$url" }
    if ($copied) { Write-Ok "設定碼已複製：在網頁的輸入框按 Ctrl+V（或右鍵 → 貼上）。" } else { Write-Info "在網頁的輸入框輸入上面的設定碼。" }
    Write-Info "在網頁上選擇 Discord 或 Telegram、貼上 Bot Token，最後按完成。這個視窗會等你，不用在這裡打字。"
    Write-Host ""
}
# 跑一次設定頁。$Run 收到一個每行呼叫的 hook，回傳結束碼。結果：Done（完成、AgEnD 已啟動）、Already（之前就設定好了）、
# Shown（設定頁有沒有出現過）。
function Invoke-BrowserSetup([scriptblock]$Run) {
    $setupSeen = @{ Url = $null; Code = $null; Shown = $false; Done = $false; Already = $false }
    $hook = {
        param([string]$line)
        $prompt = Get-SetupPrompt $line
        if ($prompt -and $prompt.Url) { $setupSeen.Url = $prompt.Url }
        if ($prompt -and $prompt.Code) { $setupSeen.Code = $prompt.Code }
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
    return @{ Exit = $exit; Done = $setupSeen.Done; Already = $setupSeen.Already; Shown = $setupSeen.Shown }
}

# 第 5 階段的設定與服務（#2235 審查：每一步都要命令成功才算完成）。回傳 $true 才可以標記完成；$false 表示使用者選擇結束，
# 進度保留，下次執行同一行指令會從這一步繼續。
$AGEND_ENV = 'export PATH=/root/.local/bin:$PATH; source /root/.nvm/nvm.sh 2>/dev/null; '
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
function Invoke-SetupAndService {
    $configured = $false
    while (-not $configured) {
        $setup = Invoke-BrowserSetup { param($hook) Invoke-WslStep -Label "等待你在瀏覽器完成設定" -Usually "設定頁 15 分鐘沒完成會自動關閉" -UpperMinutes 15 -OnLine $hook -Script ($AGEND_ENV + 'agend setup') }
        if ($setup.Done -or $setup.Already) { $configured = $true; break }
        Write-Host ""
        if ($setup.Shown) {
            Write-Warn "設定頁已經關閉，設定還沒完成（15 分鐘沒完成、閒置太久，或設定碼輸錯太多次）。"
            $again = Read-Host "  按 Enter 重新打開設定頁；輸入 n 再按 Enter 結束"
            if ($again -match '^\s*[nN]') { return $false }
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
    [PSCustomObject]@{ Id=4; Key="codex";       Name="OpenAI Codex";    Note='需 ChatGPT 帳號或 API Key';                   Install='curl -fsSL https://chatgpt.com/codex/install.sh | sh';             Bin="codex";    NeedsNode=$false }
)
# 統一 PATH：涵蓋所有後端二進位位置（.local/bin: kiro/codex-global 等；.claude/local: Claude Code）
# 不加雙引號 —— 路徑無空白，且避免 PowerShell 5.1 傳參給 wsl 時的引號轉義問題
$BACKEND_PATH = 'export PATH=/root/.local/bin:$HOME/.claude/local:$PATH'

function Save-Backends($csv) { Add-Content -Path $ProgressFile -Value "BACKENDS=$csv" }
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
    $st = @{ Tails = @((New-OutputTail $outFile $Encoding), (New-OutputTail $errFile $Encoding)); Pending = @('', ''); Progress = ''; Shown = $false }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $nextBeat = $HeartbeatSeconds
    $spin = '|/-\'
    $proc = $null

    $clearStatus = {
        if ($st.Shown) {
            $w = Get-StatusWidth
            [Console]::Write("`r" + (' ' * $w) + "`r")
            $st.Shown = $false
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
                [Console]::Write("`r" + (' ' * $w) + "`r" + (Limit-Width $line $w))
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
    if ($answer -match '^\s*[yY]') {
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

# 在 WSL 裡以 root 執行一段 bash 腳本，作為長步驟（見 Invoke-Watched）。腳本放在沒有空白的 ProgramData 路徑。
function Invoke-WslStep {
    param([string]$Label, [string]$Usually, [string]$Script, [double]$UpperMinutes = 0, [scriptblock]$OnLine = $null)
    $dir = Join-Path $env:ProgramData 'AgEnD-install'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $file = Join-Path $dir ('step-' + [Guid]::NewGuid().ToString('N') + '.sh')
    [IO.File]::WriteAllText($file, ($Script -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
    try {
        $wslFile = (wsl -d $UBUNTU_DISTRO -u root -- wslpath -u ($file -replace '\\', '\\') 2>$null | Out-String).Trim()
        if (-not $wslFile.StartsWith('/')) { $wslFile = '/mnt/' + $file.Substring(0, 1).ToLower() + ($file.Substring(2) -replace '\\', '/') }
        return (Invoke-Watched -Label $Label -Usually $Usually -UpperMinutes $UpperMinutes -OnLine $OnLine -File 'wsl.exe' -Arguments @('-d', $UBUNTU_DISTRO, '-u', 'root', '--', 'bash', $wslFile))
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
}

# ── 開始 ─────────────────────────────────────────────────

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

# 使用這個視窗的小提醒（#1853：不熟主控台的人最常卡在這幾件事）
Write-Host "  ── 使用這個視窗前，先看這幾點 ──" -ForegroundColor Yellow
Write-Info "  複製：用滑鼠選取文字，再按右鍵（或 Enter）。"
Write-Info "  貼上：在視窗裡按一下右鍵。"
Write-Info "  請不要按 Ctrl+C：在這個視窗裡，它不是「複製」，而是「停止」。"
Write-Info "    自動安裝的步驟中不小心按到，會先問你要不要停止，不會直接中斷。"
Write-Info "  自動安裝時點到視窗也沒關係，不會讓安裝暫停。"
Write-Host ""

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

$TOTAL = 5

# ═══════════════════════════════════════════════════════════
# 階段 1: 安裝 WSL + Ubuntu 24.04
# ═══════════════════════════════════════════════════════════

Write-Step 1 $TOTAL "安裝 WSL ($UBUNTU_DISTRO)"

if (Stage-Done 1) {
    Write-Ok "WSL 已安裝，跳過此步驟"
} else {
    # ── 1a: 檢查 WSL 功能是否已啟用 ──
    Write-Info "檢查 WSL 功能狀態..."
    $wslFeatureEnabled = $false
    try {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -ErrorAction SilentlyContinue
        if ($feature -and $feature.State -eq "Enabled") { $wslFeatureEnabled = $true }
    } catch {
        $statusOut = wsl --status 2>&1 | Out-String
        if ($statusOut -notmatch "Usage" -and $statusOut -notmatch "引數") { $wslFeatureEnabled = $true }
    }

    if (-not $wslFeatureEnabled) {
        Write-Info "正在啟用 WSL 功能..."
        $null = Invoke-Watched -Label "啟用 WSL 功能" -Usually "通常需要 1–3 分鐘" -UpperMinutes 5 -Encoding oem -File "dism.exe" -Arguments @("/online", "/enable-feature", "/featurename:Microsoft-Windows-Subsystem-Linux", "/all", "/norestart")
        $null = Invoke-Watched -Label "啟用虛擬機器平台" -Usually "通常需要 1–3 分鐘" -UpperMinutes 5 -Encoding oem -File "dism.exe" -Arguments @("/online", "/enable-feature", "/featurename:VirtualMachinePlatform", "/all", "/norestart")
        Write-Ok "WSL 功能已啟用"

        Mark-Stage "1a"
        Request-Reboot "WSL 功能剛啟用，需要重新開機才能繼續"
    } else {
        Write-Ok "WSL 功能已啟用"
    }

    # ── 1b: 更新 WSL 核心 ──
    Write-Info "更新 WSL 核心元件..."
    $wslUpdateCode = Invoke-Watched -Label "更新 WSL 核心元件" -Usually "通常需要 1–5 分鐘" -UpperMinutes 8 -Encoding utf16 -File "wsl.exe" -Arguments @("--update")
    if ($wslUpdateCode -ne 0) {
        # Microsoft Store 被擋（公司電腦常見）時，改從 GitHub 下載同一個更新。
        Write-Warn "從 Microsoft Store 更新失敗，改從 GitHub 下載..."
        $wslUpdateCode = Invoke-Watched -Label "從 GitHub 更新 WSL" -Usually "通常需要 1–5 分鐘" -UpperMinutes 8 -Encoding utf16 -File "wsl.exe" -Arguments @("--update", "--web-download")
    }
    if ($wslUpdateCode -ne 0) {
        Write-Warn "wsl --update 失敗，從 GitHub 下載最新版 WSL..."
        try {
            $release = Invoke-RestMethod "https://api.github.com/repos/microsoft/WSL/releases/latest" -TimeoutSec 30
            $msiAsset = $release.assets | Where-Object { $_.name -match "x64\.msi$" } | Select-Object -First 1
            if ($msiAsset) {
                $wslMsi = "$env:TEMP\wsl-latest.msi"
                Write-Info "  下載中: $($msiAsset.name) ($($release.tag_name))..."
                Invoke-WebRequest -Uri $msiAsset.browser_download_url -OutFile $wslMsi -UseBasicParsing
                $msiCode = Invoke-Watched -Label "安裝 WSL" -Usually "通常需要 1–2 分鐘" -UpperMinutes 5 -Encoding oem -File "msiexec.exe" -Arguments @("/i", $wslMsi, "/quiet", "/norestart")
                Remove-Item $wslMsi -Force -ErrorAction SilentlyContinue
                if ($msiCode -eq 0) {
                    Write-Ok "WSL $($release.tag_name) 已從 GitHub 安裝"
                } elseif ($msiCode -eq 3010) {
                    Request-Reboot "WSL 已安裝，需要重新開機才能生效"
                } else {
                    Write-Err "MSI 安裝失敗 (exit code: $msiCode)"
                    Write-Info "請手動到 https://github.com/microsoft/WSL/releases 下載 .msi 安裝"
                    Read-Host "按 Enter 結束"; exit 1
                }
            } else {
                Write-Err "找不到 MSI 下載連結"
                Write-Info "請手動到 https://github.com/microsoft/WSL/releases 下載 x64 .msi 安裝"
                Read-Host "按 Enter 結束"; exit 1
            }
        } catch {
            Write-Err "下載失敗: $_"
            Write-Info "可能原因: 網路被防火牆擋住 / 無法連線 GitHub"
            Write-Info "請手動到 https://github.com/microsoft/WSL/releases 下載 .msi 安裝"
            Read-Host "按 Enter 結束"; exit 1
        }
        # 驗證安裝
        $verifyVer = wsl --version 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Mark-Stage "1b"
            Request-Reboot "WSL 安裝完成，但還需要重新開機才能使用"
        }
    } else {
        Write-Ok "WSL 核心已更新"
    }

    # ── 1c: 設定 WSL 預設版本為 2 ──
    wsl --set-default-version 2 2>&1 | Out-Null

    # ── 1d: 檢查是否已有 Ubuntu distro ──
    $distroInstalled = $false
    $installedDistroName = $null
    $distroNames = @("Ubuntu-24.04", "Ubuntu-22.04", "Ubuntu")
    foreach ($name in $distroNames) {
        $testResult = wsl -d $name -u root -- echo "EXISTS" 2>&1 | Out-String
        if ($testResult -match "EXISTS") {
            $distroInstalled = $true
            $installedDistroName = $name
            break
        }
    }

    if ($distroInstalled) {
        Write-Ok "這台電腦已經有 $installedDistroName。"
        Write-Warn "要用它繼續的話，安裝程式會修改它的設定：開啟 systemd、預設以 root 登入、不再把 Windows 的 PATH 帶進 Linux。"
        Write-Warn "裡面的檔案不會被刪除，但你在這個 $installedDistroName 裡原本的使用習慣（預設使用者、PATH）會改變。"
        $cont = Read-Host "  要用這個 $installedDistroName 繼續嗎？輸入 y 再按 Enter 繼續；直接按 Enter 就不動它、結束安裝 (y/N)"
        if ($cont -notmatch '^\s*[yY]') {
            Write-Info "已取消，沒有改動任何東西。"
            Write-Info "如果想讓 AgEnD 用獨立的環境：先移除或改名現有的 $installedDistroName，再執行同一行安裝指令。"
            Read-Host "按 Enter 結束"; exit 0
        }
        $UBUNTU_DISTRO = $installedDistroName
    } else {
        # 自動選擇：Linux 版本固定（$UBUNTU_DISTRO），安裝位置見 Select-InstallDrive。不必再輸入數字。
        $disk = Select-InstallDrive (Get-LocalDisks) ($env:SystemDrive + '\')
        if (-not $disk) {
            Write-Err "找不到可用空間 5 GB 以上的本機磁碟，無法安裝 Linux"
            Write-Info "請先清出一些空間，再執行同一行安裝指令"
            Read-Host "按 Enter 結束"; exit 1
        }
        $wslPath = "$($disk.Root)WSL\Ubuntu"
        Write-Ok "Linux 版本：$UBUNTU_DISTRO"
        Write-Ok ("安裝位置：{0}（可用 {1} GB）" -f $wslPath, [math]::Round($disk.Free / 1GB, 1))
        Write-Host ""

        # 安裝
        Write-Info "正在安裝 $UBUNTU_DISTRO，請不要關閉視窗..."
        $null = Invoke-Watched -Label "下載並安裝 $UBUNTU_DISTRO" -Usually "通常需要 3–10 分鐘" -UpperMinutes 15 -Encoding utf16 -File "wsl.exe" -Arguments @("--install", "-d", $UBUNTU_DISTRO, "--location", $wslPath, "--no-launch")

        # 驗證
        Write-Info "正在驗證安裝結果..."
        Start-Sleep -Seconds 3
        if (Wait-WslRoot $UBUNTU_DISTRO) {
            Write-Ok "$UBUNTU_DISTRO 安裝完成"
        } else {
            Write-Err "Ubuntu 安裝失敗！"
            Write-Info "可能原因："
            Write-Info "  - 需要重新開機（請重開機後再執行同一行安裝指令）"
            Write-Info "  - 網路問題（無法下載 Ubuntu）"
            Write-Info "  - Windows 版本太舊（需要 Win10 2004 以上或 Win11）"
            Read-Host "按 Enter 結束"; exit 1
        }
    }

    Add-Content -Path $ProgressFile -Value "DISTRO=$UBUNTU_DISTRO"
    Mark-Stage 1
}

# ── 階段 1.5: WSL 環境防護 ────────────────────

# 確認 WSL 可以正常執行
if (Wait-WslRoot $UBUNTU_DISTRO) {
    Write-Ok "WSL 已就緒"
} else {
    Write-Err "WSL 無法正常執行，請重新開機後再執行同一行安裝指令"
    Read-Host "按 Enter 結束"; exit 1
}

# 防護：設定 wsl.conf（systemd + 關閉 Windows PATH + 預設 root）
Write-Info "正在設定 WSL 環境防護..."
$wslConfScript = @'
#!/bin/bash
cat > /etc/wsl.conf << 'EOF'
[boot]
systemd=true

[interop]
appendWindowsPath=false

[user]
default=root
EOF
echo "WSL_CONF_OK"
'@
$prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
$wslConfScript | wsl -d $UBUNTU_DISTRO -u root -- tee /tmp/setup-wslconf.sh > $null 2>&1
$confResult = wsl -d $UBUNTU_DISTRO -u root -- bash /tmp/setup-wslconf.sh 2>&1
$ErrorActionPreference = $prevEAP
if ($confResult -match "WSL_CONF_OK") {
    Write-Ok "WSL 環境防護已設定："
    Write-Info "  - systemd 已啟用（服務管理）"
    Write-Info "  - Windows PATH 污染已關閉（避免版本衝突）"
    Write-Info "  - 預設使用者設為 root"

    # 重啟 WSL 讓設定生效
    Write-Info "正在重啟 WSL 讓設定生效..."
    wsl --terminate $UBUNTU_DISTRO 2>$null
    Start-Sleep -Seconds 2
}

# 防護：.wslconfig（防止 WSL 自動停止）
Write-Info "正在設定 .wslconfig（防止 WSL 自動停止）..."
$wslConfigFilePath = "$env:USERPROFILE\.wslconfig"
$wslConfigContent = @"
[general]
instanceIdleTimeout=-1

[wsl2]
vmIdleTimeout=-1
"@
[IO.File]::WriteAllText($wslConfigFilePath, $wslConfigContent, (New-Object System.Text.UTF8Encoding $false))
Write-Ok ".wslconfig 已設定（WSL 不會因關閉 terminal 而停止）"

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
        Write-Info ("  [WSL] 安裝 {0}..." -f $b.Name)
        # 需要 Node 的後端（如 Codex）在 Stage 4 之前先用 nvm 引導 Node 22
        $nodePrep = ""
        if ($b.NeedsNode) {
            $nodePrep = 'export NVM_DIR=/root/.nvm; [ -s $NVM_DIR/nvm.sh ] && . $NVM_DIR/nvm.sh; if ! command -v npm >/dev/null 2>&1; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; export NVM_DIR=/root/.nvm; . $NVM_DIR/nvm.sh; nvm install 22 >/dev/null 2>&1; fi; '
        }
        $cmd = "$BACKEND_PATH; $nodePrep$($b.Install)"
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

# ═══════════════════════════════════════════════════════════
# 階段 3: 登入所選 AI 後端（瀏覽器授權）
# ═══════════════════════════════════════════════════════════

Write-Step 3 $TOTAL "登入 AI 後端"

if (Stage-Done 3) {
    Write-Ok "AI 後端已登入，跳過此步驟"
} else {
    foreach ($b in $selected) {
        Write-Host ""
        Write-Warn "═══════════════════════════════════════════════════════"
        Write-Warn ("  登入 {0}（使用瀏覽器授權）" -f $b.Name)
        Write-Warn ""
        switch ($b.Key) {
            "kiro" {
                Write-Warn "  1. 畫面會顯示一個網址（URL）"
                Write-Warn "  2. 複製該網址，貼到任何電腦的瀏覽器開啟"
                Write-Warn "  3. 用 AWS Builder ID / GitHub / Google 登入授權"
                Write-Warn "  4. 授權完成後，這裡會自動繼續"
                Write-Warn ""
                Write-Warn "  [!!] 沒有 AWS Builder ID？先到 https://profile.aws.amazon.com/ 註冊"
            }
            "claude"      { Write-Warn "  首次執行會導向 Anthropic OAuth 登入；完成後在畫面輸入 /quit 離開" }
            "antigravity" { Write-Warn "  首次執行會導向 Google Sign-In；完成後離開 CLI（依畫面提示，或按 Ctrl+D）" }
            "codex"       { Write-Warn "  首次執行會導向 ChatGPT 登入（或先設定 OPENAI_API_KEY）；完成後輸入 /quit 離開" }
        }
        Write-Warn ""
        Write-Warn "  要複製畫面上的網址：用滑鼠選取，再按右鍵。要貼上：按右鍵。"
        Write-Warn "  登入時請不要按 Ctrl+C：它會直接關掉登入程式。"
        Write-Warn "═══════════════════════════════════════════════════════"
        Write-Host ""
        Read-Host ("  準備好了嗎？按 Enter 開始登入 {0}" -f $b.Name)

        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        switch ($b.Key) {
            "kiro"        { wsl -d $UBUNTU_DISTRO -u root -- bash -lc "$BACKEND_PATH; kiro-cli login" }
            "claude"      { wsl -d $UBUNTU_DISTRO -u root -- bash -lc "$BACKEND_PATH; claude" }
            "antigravity" { wsl -d $UBUNTU_DISTRO -u root -- bash -lc "$BACKEND_PATH; agy" }
            "codex"       { wsl -d $UBUNTU_DISTRO -u root -- bash -lc "$BACKEND_PATH; codex" }
        }
        $ErrorActionPreference = $prevEAP

        if ($b.Key -eq "kiro") {
            $loginCheck = wsl -d $UBUNTU_DISTRO -u root -- bash -lc "$BACKEND_PATH; kiro-cli profile 2>/dev/null; if [ `$? -eq 0 ]; then echo LOGIN_OK; else echo LOGIN_FAIL; fi" 2>&1
            if ($loginCheck -match "LOGIN_OK") { Write-Ok "Kiro CLI 登入成功！" }
            else { Write-Warn "無法自動確認 Kiro 登入狀態（若已在瀏覽器完成授權通常沒問題）" }
        } else {
            Write-Ok ("{0} 登入流程完成" -f $b.Name)
        }
    }
    Mark-Stage 3
}

# ═══════════════════════════════════════════════════════════
# 階段 4: 安裝 AgEnD（官方安裝腳本，含 Node.js 22）
# ═══════════════════════════════════════════════════════════

Write-Step 4 $TOTAL "安裝 AgEnD"

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
        'curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash || true'
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

# ═══════════════════════════════════════════════════════════
# 階段 5: 串接通訊軟體 + 啟動服務
# ═══════════════════════════════════════════════════════════

Write-Step 5 $TOTAL "串接通訊軟體 + 啟動服務"

if (Stage-Done 5) {
    Write-Ok "已完成，跳過此步驟"
} else {
    Write-Host ""
    Write-Info "接下來在瀏覽器裡完成設定：選擇 Discord 或 Telegram、貼上 Bot Token。"
    Write-Info "設定頁會自動打開，設定碼也會幫你複製好；這個視窗不用打字。"
    if (-not (Invoke-SetupAndService)) {
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
Write-Info ("  [OK] AI 後端已安裝並登入：" + (($selected | ForEach-Object { $_.Name }) -join "、"))
Write-Info "  [OK] AgEnD 已安裝並啟動（systemd 服務）"
Write-Info "  [OK] 通訊軟體已串接"
Write-Info "  [OK] 開機自動啟動已設定"
Write-Host ""
Write-Host "  日常使用：" -ForegroundColor Cyan
Write-Info "    直接在 Discord/Telegram 跟 Bot 對話即可"
Write-Info "    不需要手動開啟任何程式"
Write-Host ""
Write-Host "  管理指令（進入 WSL 後直接輸入）：" -ForegroundColor Cyan
Write-Info "    wsl -d $UBUNTU_DISTRO          # 從 PowerShell 進入 WSL"
Write-Info "    agend ls                # 查看所有 agent 狀態"
Write-Info "    agend attach <名稱>     # 進入 agent 操作畫面"
Write-Info "    agend update            # 更新到最新版"
Write-Host ""
Write-Host "  注意事項：" -ForegroundColor Yellow
Write-Info "    - 電腦重開機後 WSL 會自動啟動，systemd 會自動拉起 AgEnD"
Write-Info "    - 手動重新啟動：wsl -d $UBUNTU_DISTRO -u root -- bash -lc 'agend start'"
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Green

# 清除進度檔與自動接續的登記
Remove-Item $ProgressFile -Force -ErrorAction SilentlyContinue
Clear-ResumeAtLogon

Read-Host "按 Enter 結束"

