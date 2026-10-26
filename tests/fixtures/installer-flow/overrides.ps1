# ── installer-flow test overrides (tests/windows-installer-flow.test.ts) ──
# Injected into a copy of install-agend.ps1 just before its main body ("# ── 開始"), which then runs as a script file the
# way install.ps1 runs it. Replaced here: Windows itself — its admin token, build, features, registry, disks, shortcuts,
# browser and network — and one Linux-side check, the internet reachability probe (Test-WslNetwork: the test's Linux has
# no network on purpose). Never the installer's own WSL, backend, port or setup logic. A new Windows-only call the
# installer starts making shows up as a failure of this test, not as a silent stub.
function Check-Admin { $true }
function Test-LiveConsole { $env:AGEND_FLOW_LIVE -eq '1' }
function Get-CurrentSid { 'S-1-5-21-1-2-3-1001' }
function Clear-Host { }
function Read-Host { param($Prompt) $q = $env:AGEND_FLOW_ANSWERS; $a = ''; if (Test-Path $q) { $all = @(Get-Content -LiteralPath $q); if ($all.Count) { $a = $all[0]; Set-Content -LiteralPath $q -Value @($all | Select-Object -Skip 1) } }; Add-Content -LiteralPath ($q + '.asked') -Value ([string]$Prompt + ' => ' + $a); $a }
# Windows itself (not what this test is about): a current, capable, connected Windows 11.
function Test-WindowsNetwork { $true }
function Test-WslNetwork([string]$distro) { $true }   # excluded boundary: real internet reachability (see above)
function Get-WindowsBuild { 22631 }
function Get-WindowsArch { 'x64' }
function Get-WslFeatureState([string]$name) { 'Enabled' }
function Test-Virtualization { $true }
function Get-InstalledWslVersion([string]$ProgramFiles) { [version]'2.4.12' }
function Register-ResumeAtLogon { $true }
function Clear-ResumeAtLogon { }
function Get-LocalDisks { @([PSCustomObject]@{ Root = 'C:\'; Free = [double]200GB }) }
# Windows' own listeners (another Linux's WSL relay, a portproxy rule…): ports in $AGEND_FAKE_WSL_STATE/windows-listeners.
function Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction)
  $f = Join-Path $env:AGEND_FAKE_WSL_STATE 'windows-listeners'
  if ((Test-Path $f) -and (@(Get-Content -LiteralPath $f) -contains [string]$LocalPort)) { return [PSCustomObject]@{ OwningProcess = 4242 } }
  throw 'No matching MSFT_NetTCPConnection objects found'
}
function Get-Process { param($Id, $ErrorAction) if ($Id -eq 4242) { return [PSCustomObject]@{ ProcessName = 'wslrelay' } }; Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction $ErrorAction }
function Get-WslRegisteredNames { $f = Join-Path $env:AGEND_FAKE_WSL_STATE 'distros'; if (Test-Path $f) { ,@(Get-Content -LiteralPath $f | Where-Object { $_ }) } else { ,@() } }
function Open-InBrowser([string]$url) { Add-Content -LiteralPath (Join-Path $env:AGEND_FAKE_WSL_STATE 'browser.log') -Value $url; $true }
function Set-SetupClipboard([string]$text) { Set-Content -LiteralPath (Join-Path $env:AGEND_FAKE_WSL_STATE 'clipboard') -Value $text; $true }
function Write-MergedWindowsWslConfig([string]$path) { }
# Windows → WSL localhost forwarding: a request from "Windows" to 127.0.0.1 reaches the Linux side's loopback.
function Invoke-WebRequest { param($Uri, [switch]$UseBasicParsing, $TimeoutSec, $MaximumRedirection, $ErrorAction)
  $code = (& docker exec $env:AGEND_FAKE_WSL_CONTAINER /usr/bin/curl -s -o /dev/null -m 3 -w '%{http_code}' ([string]$Uri)) -join ''
  if ($code -match '^[1-5]\d\d$') { return [PSCustomObject]@{ StatusCode = [int]$code } }
  throw "connection failed ($code)"
}
# The installer's own Windows paths, as this host spells them.
$ProgressFile = Join-Path $env:USERPROFILE '.agend-install-progress'
# Desktop shortcuts are Windows COM objects: recorded instead.
function Install-AgendShortcuts([string]$distro, [string]$user) { Add-Content -LiteralPath (Join-Path $env:AGEND_FAKE_WSL_STATE 'shortcuts.log') -Value ($distro + ' ' + $user); @('AgEnD 儀表板', 'AgEnD 重新啟動') }
# A URL handed to Windows to open goes to the browser log; everything else starts as it would.
function Start-Process {
  [CmdletBinding()] param([Parameter(Position = 0)][string]$FilePath, [Parameter(Position = 1)][string[]]$ArgumentList, [switch]$NoNewWindow, [switch]$Wait, [switch]$PassThru,
    [string]$Verb, [string]$WorkingDirectory, [string]$RedirectStandardOutput, [string]$RedirectStandardError, [string]$RedirectStandardInput, $WindowStyle)
  if ($FilePath -match '^https?://') { Add-Content -LiteralPath (Join-Path $env:AGEND_FAKE_WSL_STATE 'browser.log') -Value $FilePath; return }
  Microsoft.PowerShell.Management\Start-Process @PSBoundParameters
}
