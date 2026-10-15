# === AgEnD Bot Launcher (improved) ===
# Runs a reliable startup flow via WSL Ubuntu:
# clean stale processes -> wait for network -> start fleet

$ErrorActionPreference = "Continue"

Write-Host "=== Starting AgEnD Bot ===" -ForegroundColor Cyan
Write-Host "Launching @jungo_No2_bot via WSL ..." -ForegroundColor Yellow

# Path of the bash script inside WSL
# (maps to C:\Users\chunchenliu\Desktop\kiro\agend-start.sh)
$bashScript = "/mnt/c/Users/chunchenliu/Desktop/kiro/agend-start.sh"

# Run the startup script (-lic = login shell so user env / nvm is loaded)
wsl -d Ubuntu bash -lic "bash '$bashScript'"

Write-Host ""
Write-Host "=== Startup flow finished ===" -ForegroundColor Green
Write-Host "  Bot: @jungo_No2_bot" -ForegroundColor Green
Write-Host "  Log: ~/.agend/autostart.log (inside WSL)" -ForegroundColor Gray
Write-Host "  Check Telegram to confirm the bot responds." -ForegroundColor Gray
