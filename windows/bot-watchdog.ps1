# === AgEnD Bot Watchdog ===
$ErrorActionPreference = "Continue"
$CheckScript  = "/mnt/c/Users/chunchenliu/Desktop/kiro/check-bot-status.sh"
$StartScript  = "/mnt/c/Users/chunchenliu/Desktop/kiro/agend-start.sh"
$CheckInterval = 300   # seconds
$LogFile = "C:\Users\chunchenliu\Desktop\kiro\watchdog.log"

# Load assemblies once at startup
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---- helpers ----
function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

function Show-Balloon($title, $msg, $icon = "Warning") {
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon    = [System.Drawing.SystemIcons]::$icon
    $n.Visible = $true
    $n.BalloonTipTitle = $title
    $n.BalloonTipText  = $msg
    $n.BalloonTipIcon  = $icon
    $n.ShowBalloonTip(8000)
    Start-Sleep -Milliseconds 300
    $n.Dispose()
}

function New-DarkForm($title, $w, $h) {
    $f = New-Object System.Windows.Forms.Form
    $f.Text        = $title
    $f.Size        = New-Object System.Drawing.Size($w, $h)
    $f.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $f.TopMost     = $true
    $f.BackColor   = [System.Drawing.Color]::FromArgb(30, 30, 30)
    $f.ForeColor   = [System.Drawing.Color]::White
    $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $f.MaximizeBox = $false
    return $f
}

function New-Label($text, $x, $y, $w, $h, $size = 10, $bold = $false, $color = $null) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text     = $text
    $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.Size     = New-Object System.Drawing.Size($w, $h)
    $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $l.Font     = New-Object System.Drawing.Font("Segoe UI", $size, $style)
    $l.ForeColor = if ($color) { $color } else { [System.Drawing.Color]::FromArgb(220, 220, 220) }
    return $l
}

function New-DarkButton($text, $x, $y, $w, $h, $primary = $false) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text      = $text
    $b.Location  = New-Object System.Drawing.Point($x, $y)
    $b.Size      = New-Object System.Drawing.Size($w, $h)
    $b.BackColor = if ($primary) { [System.Drawing.Color]::FromArgb(0,120,215) } else { [System.Drawing.Color]::FromArgb(60,60,60) }
    $b.ForeColor = [System.Drawing.Color]::White
    $fontStyle   = if ($primary) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $b.Font      = New-Object System.Drawing.Font("Segoe UI", 10, $fontStyle)
    $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    return $b
}

# ---- login flow ----
function Do-Login() {
    Write-Log "Starting claude /login..."
    wsl -d Ubuntu bash -lic "tmux kill-session -t wd_login 2>/dev/null; tmux new-session -d -s wd_login -x 220 -y 50; tmux send-keys -t wd_login 'claude /login' Enter"
    Start-Sleep -Seconds 6
    wsl -d Ubuntu bash -lic "tmux send-keys -t wd_login '1' Enter"
    Start-Sleep -Seconds 8

    $rawUrl = wsl -d Ubuntu bash -lic "tmux capture-pane -t wd_login -p | grep 'https://claude.com' | head -1 | tr -d ' '"
    $url = ($rawUrl -split "`n" | Where-Object { $_ -match "https://claude.com" } | Select-Object -First 1).Trim()

    if (-not ($url -match "https://claude.com")) {
        Write-Log "Could not get auth URL"; return
    }
    Start-Process $url
    Write-Log "Browser opened"

    # Code input form
    $f  = New-DarkForm "貼上授權 Code" 500 165
    $lb = New-Label "在瀏覽器授權後，把頁面上的 Code 貼到這裡：" 15 15 465 25
    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Location  = New-Object System.Drawing.Point(15, 45)
    $tb.Size      = New-Object System.Drawing.Size(465, 25)
    $tb.BackColor = [System.Drawing.Color]::FromArgb(50, 50, 50)
    $tb.ForeColor = [System.Drawing.Color]::White
    $tb.Font      = New-Object System.Drawing.Font("Consolas", 10)
    $btn = New-DarkButton "確認送出" 15 82 120 35 $true
    $btn.Add_Click({ $f.Tag = $tb.Text; $f.Close() })
    $f.Controls.AddRange(@($lb, $tb, $btn))
    $f.ShowDialog() | Out-Null

    $code = (($f.Tag -split "#")[0]).Trim()
    if (-not $code -or $code.Length -lt 10) { Write-Log "No code entered"; return }

    wsl -d Ubuntu bash -lic "tmux send-keys -t wd_login '$code' Enter"
    Start-Sleep -Seconds 10
    Write-Log "Code submitted — restarting fleet..."
    wsl -d Ubuntu bash -lic "bash '$StartScript'"
    Show-Balloon "AgEnD Bot" "Bot 已重新啟動！" "Info"
    Write-Log "Fleet restarted"
}

function Show-LoginPrompt() {
    $f    = New-DarkForm "AgEnD Bot - 需要重新登入" 420 205
    $lbT  = New-Label "Bot 已停止運作" 20 20 380 30 13 $true ([System.Drawing.Color]::FromArgb(255,200,0))
    $lbM  = New-Label "Claude 登入已過期，Bot 無法回應。`n請點 [重新登入] 完成授權後 Bot 會自動重啟。" 20 58 380 55
    $btnL = New-DarkButton "重新登入" 20 125 155 38 $true
    $btnI = New-DarkButton "稍後提醒" 190 125 120 38
    $btnL.Add_Click({ $f.Tag = "login"; $f.Close() })
    $btnI.Add_Click({ $f.Close() })
    $f.Controls.AddRange(@($lbT, $lbM, $btnL, $btnI))
    $f.ShowDialog() | Out-Null
    return $f.Tag
}

# ===== Main Loop =====
Write-Log "=== Watchdog started (interval: ${CheckInterval}s) ==="
$lastNotify = [DateTime]::MinValue
$errCount   = 0

while ($true) {
    try {
        $json = $null
        for ($retry = 0; $retry -lt 2; $retry++) {
            $json = wsl -d Ubuntu bash -lic "bash '$CheckScript' 2>/dev/null" |
                    Where-Object { $_ -match "^\{" } | Select-Object -Last 1
            if ($json) { break }
            Start-Sleep -Seconds 3
        }

        if (-not $json) {
            Write-Log "WARN: no status (WSL not ready?)"
            Start-Sleep -Seconds $CheckInterval
            continue
        }

        $s = $json | ConvertFrom-Json

        switch ($s.status) {
            "ok"      { $errCount = 0; Write-Log "OK | fleet:$($s.fleet_running) claude:$($s.claude_count) token:$($s.access_remaining_hours)h" }
            "warning" { $errCount = 0; Write-Log "WARN | $($s.reason)" }
            default   {
                $errCount++
                Write-Log "ERROR [$errCount] | $($s.reason)"

                if ($errCount -ge 2 -and ([DateTime]::Now - $lastNotify).TotalMinutes -gt 30) {
                    $lastNotify = [DateTime]::Now
                    $errCount   = 0

                    if ($s.reason -match "logged|expired") {
                        if ((Show-LoginPrompt) -eq "login") { Do-Login }
                    } else {
                        Show-Balloon "AgEnD Bot 停止運作" "原因: $($s.reason) — 嘗試自動重啟..." "Warning"
                        wsl -d Ubuntu bash -lic "bash '$StartScript'"
                        Write-Log "Auto-restart triggered"
                    }
                }
            }
        }
    }
    catch { Write-Log "ERROR: $_" }
    finally { Start-Sleep -Seconds $CheckInterval }
}