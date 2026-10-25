# AgEnD 桌面捷徑（#1853）：`agend shortcuts` 在 WSL 裡經由 powershell.exe 執行這份文字，建立或更新「AgEnD 儀表板」和
# 「AgEnD 重新啟動」兩個桌面捷徑。第一個空白行以下和 website/public/install-agend.ps1 裡的同一段一字不差
# （tests/windows-shortcuts-cli-1853.test.ts 檢查）：改的時候兩邊一起改。

$WSL_COMMAND_FN = @'
function Invoke-BoundedWsl {
param([string[]]$Arguments, [int]$TimeoutSeconds = 30)
$sep = [array]::IndexOf($Arguments, '--')
if ($sep -ge 0 -and $Arguments.Length -gt ($sep + 1) -and $Arguments[$sep + 1] -eq 'bash') {
$Arguments = @($Arguments[0..$sep]) + @('timeout', '--signal=TERM', '--kill-after=2s', [string]([Math]::Max(1, $TimeoutSeconds - 5))) + @($Arguments[($sep + 1)..($Arguments.Length - 1)])
}
$p = New-Object Diagnostics.Process
$p.StartInfo.FileName = 'wsl.exe'
$p.StartInfo.Arguments = (@($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
$p.StartInfo.UseShellExecute = $false; $p.StartInfo.CreateNoWindow = $true
$p.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8; $p.StartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
$p.StartInfo.RedirectStandardOutput = $true; $p.StartInfo.RedirectStandardError = $true; $p.StartInfo.RedirectStandardInput = $true
try {
$null = $p.Start(); $p.StandardInput.Close()
$out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
$p.Kill(); $null = $p.WaitForExit(10000)
return @{Code=124;Text='WSL timed out; check it before retrying.'}
}
if (-not $out.Wait(1000) -or -not $err.Wait(1000)) { return @{Code=1;Text='WSL output did not close.'} }
$text = $out.Result + $err.Result
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
      $r = Invoke-BoundedWsl -Arguments @('-d', $distro, '-u', $user, '--', 'bash', '-lc', (Get-WslAgendCommand $command))
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
      return (Invoke-BoundedWsl -TimeoutSeconds $limit -Arguments @('-d', $distro, '-u', $user, '--', 'bash', '-lc', (Get-WslAgendCommand $command)))
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
