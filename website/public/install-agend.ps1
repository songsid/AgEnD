# ═══════════════════════════════════════════════════════════
# AgEnD + Kiro CLI 一鍵安裝腳本 (Windows PowerShell 5)
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

function Check-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ── 開始 ─────────────────────────────────────────────────

Clear-Host
Write-Host "=" * 43 -ForegroundColor Magenta
Write-Host "   AgEnD + Kiro CLI 自動安裝程式 v3.0" -ForegroundColor Magenta
Write-Host "=" * 43 -ForegroundColor Magenta
Write-Host ""
Write-Info "固定環境版本: $UBUNTU_DISTRO / Node.js $NODE_VERSION LTS"
Write-Host ""

if (-not (Check-Admin)) {
    Write-Err "此腳本需要以「系統管理員身分」執行！"
    Write-Info "請右鍵點擊 PowerShell →「以系統管理員身分執行」"
    Read-Host "按 Enter 結束"; exit 1
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

if ((Test-Path $ProgressFile) -and -not $Force) {
    Write-Warn "偵測到上次安裝進度，將從中斷處繼續"
    Write-Info "如需重新安裝，請執行: .\install-agend.ps1 -Force"
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
        Write-Info "正在啟用 WSL 功能（可能需要一點時間）..."
        dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart 2>$null | Out-Null
        dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart 2>$null | Out-Null
        Write-Ok "WSL 功能已啟用"

        Write-Warn "WSL 功能剛啟用，需要重新開機才能繼續"
        Mark-Stage "1a"
        $reboot = Read-Host "  是否現在重新開機？(Y/n)"
        if ($reboot -ne "n" -and $reboot -ne "N") { Restart-Computer -Force }
        Write-Info "請手動重新開機後，再次執行此腳本"
        exit 0
    } else {
        Write-Ok "WSL 功能已啟用"
    }

    # ── 1b: 更新 WSL 核心 ──
    Write-Info "更新 WSL 核心元件..."
    $wslUpdateOutput = wsl --update 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "wsl --update 失敗，從 GitHub 下載最新版 WSL..."
        try {
            $release = Invoke-RestMethod "https://api.github.com/repos/microsoft/WSL/releases/latest" -TimeoutSec 30
            $msiAsset = $release.assets | Where-Object { $_.name -match "x64\.msi$" } | Select-Object -First 1
            if ($msiAsset) {
                $wslMsi = "$env:TEMP\wsl-latest.msi"
                Write-Info "  下載中: $($msiAsset.name) ($($release.tag_name))..."
                Invoke-WebRequest -Uri $msiAsset.browser_download_url -OutFile $wslMsi -UseBasicParsing
                Write-Info "  安裝中（可能需要 1-2 分鐘）..."
                $msiProc = Start-Process msiexec.exe -ArgumentList "/i",$wslMsi,"/quiet","/norestart" -Wait -PassThru
                Remove-Item $wslMsi -Force -ErrorAction SilentlyContinue
                if ($msiProc.ExitCode -eq 0) {
                    Write-Ok "WSL $($release.tag_name) 已從 GitHub 安裝"
                } elseif ($msiProc.ExitCode -eq 3010) {
                    Write-Warn "WSL 已安裝但需要重新開機才能生效"
                    Write-Info "請重新開機後再次執行此腳本"
                    Read-Host "按 Enter 結束"; exit 0
                } else {
                    Write-Err "MSI 安裝失敗 (exit code: $($msiProc.ExitCode))"
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
            Write-Warn "WSL 安裝完成但 wsl --version 仍失敗，可能需要重新開機"
            Mark-Stage "1b"
            $reboot = Read-Host "  是否現在重新開機？(Y/n)"
            if ($reboot -ne "n" -and $reboot -ne "N") { Restart-Computer -Force }
            Write-Info "請手動重新開機後，再次執行此腳本"
            exit 0
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
        Write-Ok "偵測到已安裝: $installedDistroName"
        Write-Warn "此腳本將設定 $installedDistroName 為 root 模式（systemd + 關閉 Windows PATH）"
        $cont = Read-Host "  是否繼續？(Y/n)"
        if ($cont -eq "n" -or $cont -eq "N") {
            Write-Info "已取消。如需安裝到獨立環境，請手動移除現有 distro 後重試"
            Read-Host "按 Enter 結束"; exit 0
        }
        $UBUNTU_DISTRO = $installedDistroName
    } else {
        # 查詢可用清單
        Write-Info "正在查詢可用的 Linux 版本..."
        $onlineRaw = wsl --list --online 2>&1

        $ubuntuOptions = @()
        foreach ($line in $onlineRaw) {
            $lineStr = $line.ToString().Trim()
            if ($lineStr -match "^(Ubuntu\S*)\s") {
                $ubuntuOptions += $Matches[1]
            }
        }

        if ($ubuntuOptions.Count -eq 0) {
            Write-Warn "無法自動解析版本清單，提供預設選項："
            $ubuntuOptions = @("Ubuntu-24.04", "Ubuntu-22.04", "Ubuntu")
        }

        Write-Host ""
        Write-Info "請選擇要安裝的 Linux 版本："
        Write-Host ""
        for ($i = 0; $i -lt $ubuntuOptions.Count; $i++) {
            $rec = if ($i -eq 0) { "（推薦）" } else { "" }
            Write-Info "  [$($i+1)] $($ubuntuOptions[$i]) $rec"
        }
        Write-Host ""
        $distroChoice = Read-Host "  請輸入數字 (預設 1)"
        if ([string]::IsNullOrEmpty($distroChoice)) { $distroChoice = "1" }
        $UBUNTU_DISTRO = $ubuntuOptions[[int]$distroChoice - 1]
        Write-Ok "選擇安裝: $UBUNTU_DISTRO"

        # 選擇安裝磁碟槽
        Write-Host ""
        Write-Info "請選擇 WSL 安裝位置（建議選擇 SSD 磁碟）："
        Write-Host ""
        $drives = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -gt 5GB }
        $i = 1; $driveOptions = @()
        foreach ($d in $drives) {
            $freeGB = [math]::Round($d.Free / 1GB, 1)
            Write-Info "  [$i] $($d.Root) (可用空間: ${freeGB} GB)"
            $driveOptions += $d.Root; $i++
        }
        Write-Host ""
        $choice = Read-Host "  請輸入數字選擇 (預設 1)"
        if ([string]::IsNullOrEmpty($choice)) { $choice = "1" }
        $selectedDrive = $driveOptions[[int]$choice - 1]
        $wslPath = "${selectedDrive}WSL\Ubuntu"
        Write-Info "WSL 將安裝到: $wslPath"
        Write-Host ""

        # 安裝提示
        Write-Warn "═══════════════════════════════════════════════════════"
        Write-Warn "  即將開始安裝 $UBUNTU_DISTRO"
        Write-Warn "  下載可能需要 3-10 分鐘，請耐心等待"
        Write-Warn "═══════════════════════════════════════════════════════"
        Write-Host ""
        Read-Host "  了解了嗎？按 Enter 開始安裝"

        # 安裝
        Write-Info "正在安裝 $UBUNTU_DISTRO（下載中，可能需要 3-10 分鐘）..."
        Write-Info "請耐心等待，不要關閉視窗..."
        wsl --install -d $UBUNTU_DISTRO --location $wslPath --no-launch

        # 驗證
        Write-Info "正在驗證安裝結果..."
        Start-Sleep -Seconds 3
        $verifyResult = wsl -d $UBUNTU_DISTRO -u root -- echo "WSL_OK" 2>&1 | Out-String

        if ($verifyResult -match "WSL_OK") {
            Write-Ok "$UBUNTU_DISTRO 安裝完成"
        } else {
            Write-Info "嘗試初始化 $UBUNTU_DISTRO..."
            $proc = Start-Process "wsl.exe" -ArgumentList "-d",$UBUNTU_DISTRO -PassThru
            Write-Info "如果出現設定畫面，請完成後輸入 exit"
            $proc.WaitForExit()
            Start-Sleep -Seconds 2

            $verifyResult2 = wsl -d $UBUNTU_DISTRO -u root -- echo "WSL_OK" 2>&1 | Out-String
            if ($verifyResult2 -match "WSL_OK") {
                Write-Ok "$UBUNTU_DISTRO 安裝完成"
            } else {
                Write-Err "Ubuntu 安裝失敗！"
                Write-Info "可能原因："
                Write-Info "  - 需要重新開機（請重開機後再執行腳本）"
                Write-Info "  - 網路問題（無法下載 Ubuntu）"
                Write-Info "  - Windows 版本太舊（需要 Win10 2004 以上或 Win11）"
                Read-Host "按 Enter 結束"; exit 1
            }
        }
    }

    Mark-Stage 1
}

# ── 階段 1.5: WSL 環境防護 ────────────────────

# 確認 WSL 可以正常執行
$wslReady = $false
$testOutput = wsl -d $UBUNTU_DISTRO -u root -- echo "ready" 2>&1 | Out-String
if ($testOutput -match "ready") { $wslReady = $true }

if (-not $wslReady) {
    Write-Warn "WSL 尚未就緒，開啟設定視窗..."
    Write-Warn "如果出現設定畫面，請完成後輸入 exit"
    $proc = Start-Process "wsl.exe" -ArgumentList "-d",$UBUNTU_DISTRO -PassThru
    $proc.WaitForExit()
    Start-Sleep -Seconds 2

    $testOutput2 = wsl -d $UBUNTU_DISTRO -u root -- echo "ready" 2>&1 | Out-String
    if ($testOutput2 -match "ready") {
        Write-Ok "WSL 已就緒"
    } else {
        Write-Err "WSL 無法正常執行，請重新開機後再試"
        Read-Host "按 Enter 結束"; exit 1
    }
} else {
    Write-Ok "WSL 已就緒"
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
# 階段 2: 安裝 Kiro CLI + PATH 設定
# ═══════════════════════════════════════════════════════════

Write-Step 2 $TOTAL "安裝 Kiro CLI"

if (Stage-Done 2) {
    Write-Ok "Kiro CLI 已安裝，跳過此步驟"
} else {
    Write-Info "正在 WSL 內安裝 Kiro CLI（以 root 安裝）..."

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    Write-Info "（正在 WSL 內執行安裝，請等待...）"
    Write-Host ""

    Write-Info "  [WSL] 安裝必要套件..."
    wsl -d $UBUNTU_DISTRO -u root -- bash -c 'apt-get install -y unzip curl git 2>/dev/null || true' 2>&1 | Out-Null

    Write-Info "  [WSL] 移除舊版 Kiro CLI（如有）..."
    wsl -d $UBUNTU_DISTRO -u root -- bash -c 'rm -rf /root/.local/bin/kiro-cli /root/.local/bin/kiro-cli-chat /root/.local/bin/kiro-cli-term 2>/dev/null' 2>&1 | Out-Null

    Write-Info "  [WSL] 下載並安裝 Kiro CLI..."
    wsl -d $UBUNTU_DISTRO -u root -- bash -c 'curl -fsSL https://cli.kiro.dev/install | bash' 2>&1 | ForEach-Object {
        $line = $_.ToString().Trim()
        if ($line -match "\S" -and $line -notmatch "RemoteException") {
            Write-Info "    $line"
        }
    }

    Write-Info "  [WSL] 設定 PATH..."
    wsl -d $UBUNTU_DISTRO -u root -- bash -c 'if ! grep -q "/root/.local/bin" /root/.bashrc 2>/dev/null; then echo "export PATH=\"/root/.local/bin:\$PATH\"" >> /root/.bashrc; fi' 2>&1 | Out-Null
    wsl -d $UBUNTU_DISTRO -u root -- bash -c 'if ! grep -q "/root/.local/bin" /root/.profile 2>/dev/null; then echo "export PATH=\"/root/.local/bin:\$PATH\"" >> /root/.profile; fi' 2>&1 | Out-Null

    Write-Info "  [WSL] 驗證安裝..."
    $result = wsl -d $UBUNTU_DISTRO -u root -- bash -c 'export PATH="/root/.local/bin:$PATH"; if kiro-cli --version > /dev/null 2>&1; then echo "KIRO_VER=$(kiro-cli --version)"; echo "KIRO_INSTALL_OK"; else echo "KIRO_INSTALL_FAIL"; fi' 2>&1

    Write-Host ""
    $ErrorActionPreference = $prevEAP

    if ($result -match "KIRO_INSTALL_OK") {
        $ver = if ($result -match "KIRO_VER=(.+)") { $Matches[1] } else { "unknown" }
        Write-Ok "Kiro CLI v$ver 安裝完成"
        Write-Ok "PATH 已設定（/root/.bashrc + /root/.profile）"
        Mark-Stage 2
    } else {
        Write-Err "Kiro CLI 安裝失敗"
        Write-Info "錯誤訊息:"
        $result | ForEach-Object { Write-Info "  $_" }
        Write-Host ""
        Write-Info "可能原因："
        Write-Info "  - 網路連線問題（公司防火牆可能擋住下載）"
        Write-Info "  - 磁碟空間不足"
        Write-Info "解法：確認網路後重新執行腳本"
        Read-Host "按 Enter 結束"; exit 1
    }
}

# ═══════════════════════════════════════════════════════════
# 階段 3: Kiro CLI 登入（URL 方式）
# ═══════════════════════════════════════════════════════════

Write-Step 3 $TOTAL "登入 Kiro CLI"

if (Stage-Done 3) {
    Write-Ok "Kiro CLI 已登入，跳過此步驟"
} else {
    Write-Host ""
    Write-Warn "═══════════════════════════════════════════════════════"
    Write-Warn "  接下來需要登入 Kiro CLI（使用瀏覽器授權）"
    Write-Warn ""
    Write-Warn "  操作步驟："
    Write-Warn "  1. 畫面會顯示一個網址（URL）"
    Write-Warn "  2. 複製該網址，貼到任何電腦的瀏覽器開啟"
    Write-Warn "  3. 在瀏覽器中用 AWS Builder ID 登入"
    Write-Warn "  4. 授權完成後，這裡會自動繼續"
    Write-Warn ""
    Write-Warn "  [!!] 如果沒有 AWS Builder ID，請先到以下網址註冊："
    Write-Warn "  https://profile.aws.amazon.com/"
    Write-Warn "═══════════════════════════════════════════════════════"
    Write-Host ""
    Read-Host "  準備好了嗎？按 Enter 開始登入"

    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    wsl -d $UBUNTU_DISTRO -u root -- bash -lc 'export PATH=/root/.local/bin:$PATH; kiro-cli login'
    $ErrorActionPreference = $prevEAP

    # 驗證登入
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $loginCheck = wsl -d $UBUNTU_DISTRO -u root -- bash -lc 'export PATH=/root/.local/bin:$PATH; kiro-cli profile 2>/dev/null; if [ $? -eq 0 ]; then echo LOGIN_OK; else echo LOGIN_FAIL; fi' 2>&1
    $ErrorActionPreference = $prevEAP

    if ($loginCheck -match "LOGIN_OK") {
        Write-Ok "Kiro CLI 登入成功！"
        Mark-Stage 3
    } else {
        Write-Warn "無法自動確認登入狀態"
        Write-Info "如果剛才已在瀏覽器完成授權，通常是成功的"
        $cont = Read-Host "  是否繼續？(Y/n)"
        if ($cont -eq "n" -or $cont -eq "N") {
            Write-Info "請重新執行腳本再試"; exit 0
        }
        Mark-Stage 3
    }
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
    wsl -d $UBUNTU_DISTRO -u root -- bash -c 'apt-get install -y -qq tmux > /dev/null 2>&1' 2>&1 | Out-Null

    Write-Info "  [WSL] 執行 AgEnD 官方安裝腳本（含 nvm + Node.js $NODE_VERSION + 編譯工具）..."
    $agendScript = "$env:TEMP\install-agend-wsl.sh"
    $scriptLines = @(
        '#!/bin/bash'
        'export HOME=/root'
        '# 官方安裝腳本（non-interactive piped 不會觸發 quickstart）'
        'curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash || true'
        '# 確保 nvm 設定寫入 .bashrc 和 .profile'
        'if ! grep -q "NVM_DIR" /root/.bashrc 2>/dev/null; then printf "\nexport NVM_DIR=\"/root/.nvm\"\n[ -s \"\$NVM_DIR/nvm.sh\" ] && source \"\$NVM_DIR/nvm.sh\"\n" >> /root/.bashrc; fi'
        'if ! grep -q "NVM_DIR" /root/.profile 2>/dev/null; then printf "\nexport NVM_DIR=\"/root/.nvm\"\n[ -s \"\$NVM_DIR/nvm.sh\" ] && source \"\$NVM_DIR/nvm.sh\"\n" >> /root/.profile; fi'
    )
    $scriptContent = $scriptLines -join "`n"
    [IO.File]::WriteAllText($agendScript, $scriptContent, (New-Object System.Text.UTF8Encoding $false))

    # 轉換 Windows 路徑為 WSL 路徑
    $wslScriptPath = wsl -d $UBUNTU_DISTRO -u root -- wslpath -u ($agendScript -replace '\\', '\\')

    wsl -d $UBUNTU_DISTRO -u root -- bash $wslScriptPath 2>&1 | ForEach-Object {
        $line = $_.ToString().Trim()
        if ($line -match "\S" -and $line -notmatch "RemoteException") {
            Write-Info "  [WSL] $line"
        }
    }

    # 清理暫存檔
    Remove-Item $agendScript -Force -ErrorAction SilentlyContinue

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
    Write-Info "接下來將執行 AgEnD quickstart（互動式設定）"
    Write-Info "  - 選擇通訊軟體（Discord / Telegram）"
    Write-Info "  - 輸入 Bot Token"
    Write-Info "  - 在群組發一則訊息讓 Bot 偵測"
    Write-Info "  - 自動產生設定 + 安裝 service + 啟動"
    Write-Host ""
    Read-Host "  準備好了嗎？按 Enter 開始"

    $prevEAP5 = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    wsl -d $UBUNTU_DISTRO -u root -- bash -lc 'export PATH=/root/.local/bin:$PATH; source /root/.nvm/nvm.sh 2>/dev/null; agend quickstart'
    $ErrorActionPreference = $prevEAP5

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
Write-Info "  [OK] Kiro CLI 已安裝並登入"
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

# 清除進度檔
Remove-Item $ProgressFile -Force -ErrorAction SilentlyContinue

Read-Host "按 Enter 結束"

