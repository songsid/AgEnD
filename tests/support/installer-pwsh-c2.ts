/** Batch C2's boundaries, layered over the accepted shared one-worker fixture. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { InstallerPsBatch, hasPwsh } from "./installer-ps-batch.js";
export { hasPwsh };
export class InstallerC2Batch {
  private worker: InstallerPsBatch;
  constructor(templates: Record<string, string>) {
    // Pass a compiled block through the public template/body API; each file dotsources it in its own script scope.
    this.worker = new InstallerPsBatch(Object.fromEntries(Object.entries(templates).map(([name, source]) =>
      [name, `function Get-C2Prelude { return {\n${source}\n} }`])));
  }
  run(template: string, body: string, dir: string, env: Record<string, string> = {}) {
    const file = join(dir, "case.ps1");
    writeFileSync(file, `param([scriptblock]$FixturePrelude)
$ErrorActionPreference = 'Stop'
. $FixturePrelude
$global:LASTEXITCODE = 0
$script:OnWindows = $false
$script:InstallLog = $null; $script:WatchQuiet = $false
$script:FixtureMilliseconds = 0.0
$script:FixtureClock = @{ Elapsed = @{ TotalSeconds = 0.0; TotalMilliseconds = 0.0; TotalMinutes = 0.0 } }
$script:FixtureTick = $null
function Get-Date { param([string]$Format)
  $now = ([datetime]'2026-01-01').AddMilliseconds($script:FixtureMilliseconds)
  if ($Format) { return $now.ToString($Format) }; return $now
}
function Start-Sleep { param([double]$Seconds, [double]$Milliseconds)
  $script:FixtureMilliseconds += $Milliseconds + 1000 * $Seconds
  $script:FixtureClock.Elapsed.TotalMilliseconds = $script:FixtureMilliseconds
  $script:FixtureClock.Elapsed.TotalSeconds = $script:FixtureMilliseconds / 1000
  $script:FixtureClock.Elapsed.TotalMinutes = $script:FixtureMilliseconds / 60000
  if ($script:FixtureTick) { & $script:FixtureTick }
}
function wsl { throw 'Native WSL forbidden' }
function wsl.exe { throw 'Native WSL forbidden' }
function netsh.exe { throw 'Native network settings forbidden' }
function Remove-ItemProperty { throw 'Real registry write forbidden' }
function Read-Host { throw 'Unexpected terminal interaction' }
function Start-Process { throw 'Unstubbed process/browser launch forbidden' }
function Invoke-WebRequest { throw 'Real network forbidden' }
function Invoke-RestMethod { throw 'Real network forbidden' }
function Restart-Computer { throw 'Reboot forbidden' }
function Set-Clipboard { throw 'Real clipboard forbidden' }
function Set-ItemProperty { throw 'Real registry write forbidden' }
function New-Object {
 [CmdletBinding()] param([Parameter(Position=0)][string]$TypeName,[Parameter(Position=1)][object[]]$ArgumentList,[string]$ComObject,[hashtable]$Property)
 if ($ComObject) { throw 'Real COM forbidden' }
 Microsoft.PowerShell.Utility\\New-Object @PSBoundParameters
}
Push-Location $env:TMPDIR
try {
${body}
} finally { Pop-Location }
`);
    const literal = (value: string) => "'" + value.replace(/'/g,"''") + "'";
    return this.worker.run(template, `& ${literal(file)} (Get-C2Prelude)`, { env: { HOME: dir, USERPROFILE: dir, TMPDIR: dir, TMP: dir, TEMP: dir, AGEND_HOME: join(dir,"agend"), LOCALAPPDATA: join(dir,"localappdata"), AGEND_VERSION: "", AGEND_WSL_DRIVE: "", ...env } });
  }
}
