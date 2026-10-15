# === Install AgEnD Bot Autostart (Windows Task Scheduler) ===
# Run once. After that, the bot starts automatically at each Windows logon.

$ErrorActionPreference = "Stop"

$taskName   = "AgEnD-Bot-Autostart"
$scriptPath = "C:\Users\chunchenliu\Desktop\kiro\start-bots.ps1"

Write-Host "=== Installing AgEnD Bot Autostart ===" -ForegroundColor Cyan

# Remove existing task with the same name (for clean re-install)
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Existing task found, removing old one..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Action: run start-bots.ps1 hidden
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""

# Trigger: at current user logon, delayed 30s (wait for WSL + network)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = "PT30S"

# Settings: allow on battery, start when available, no time limit
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

# Run as current user (interactive, to access WSL user environment)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Auto-start AgEnD Telegram Bot (@jungo_No2_bot) after Windows logon" | Out-Null

Write-Host ""
Write-Host "Installed successfully!" -ForegroundColor Green
Write-Host "  Task name : $taskName" -ForegroundColor Gray
Write-Host "  Trigger   : at logon, 30s delay" -ForegroundColor Gray
Write-Host "  Script    : $scriptPath" -ForegroundColor Gray
Write-Host ""
Write-Host "The bot will auto-start on next Windows logon." -ForegroundColor Cyan
Write-Host "To test now, run: Start-ScheduledTask -TaskName AgEnD-Bot-Autostart" -ForegroundColor Gray
